import type { Theme } from "@earendil-works/pi-coding-agent"
import {
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import { copyTextToClipboard } from "./clipboard.js"
import { resolvePath } from "./path.js"
import { type LineRange, RangeCommentStore } from "./range-comment-store.js"
import { decorateSearchMatches } from "./search.js"
import type {
  FileViewerResult,
  ReviewComment,
  ReviewFile,
  ReviewLineKind,
} from "./types.js"
import {
  borderLine,
  fillSelected,
  padToWidth,
  renderHeader,
  separatorLine,
} from "./ui/frame.js"
import {
  isBottom,
  isDown,
  isEscape,
  isHalfPageDown,
  isHalfPageUp,
  isHideViewer,
  isQuit,
  isTop,
  isUp,
} from "./ui/keys.js"
import { LineBuffer } from "./ui/line-buffer.js"
import { TextPrompt } from "./ui/text-prompt.js"
import { VisualLineSelection } from "./ui/visual-line-selection.js"
import { highlightForPath } from "./utils/markdown-highlight.js"

type Mode = "view" | "comment" | "search"

interface FileViewerComponentOptions {
  file: ReviewFile
  cwd: string
  theme: Theme
  visibleHeight: number
  onClose: (result: FileViewerResult) => void
  onHide: () => void
  onRequestRender: () => void
}

export class FileViewerComponent implements Focusable {
  private file: ReviewFile
  private cwd: string
  private theme: Theme
  private visibleHeight: number
  private onClose: (result: FileViewerResult) => void
  private onHide: () => void
  private onRequestRender: () => void
  private comments = new RangeCommentStore<undefined>()
  private pendingCommentRange?: LineRange
  private buffer = new LineBuffer<string>()
  private visualSelection = new VisualLineSelection()
  private cachedWidth?: number
  private cachedHeight?: number
  private cachedLines?: string[]
  private mode: Mode = "view"
  private commentPrompt = new TextPrompt({
    onSubmit: (value) => this.saveCommentValue(value),
    onCancel: () => this.cancelCommentInput(),
  })
  private searchPrompt = new TextPrompt({
    onSubmit: (value) => this.saveSearchValue(value),
    onCancel: () => this.cancelSearchInput(),
  })
  private searchQuery = ""
  private copyStatus = ""
  private _focused = false

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.commentPrompt.focused = value && this.mode === "comment"
    this.searchPrompt.focused = value && this.mode === "search"
  }

  constructor(options: FileViewerComponentOptions) {
    this.file = options.file
    this.cwd = options.cwd
    this.theme = options.theme
    this.visibleHeight = options.visibleHeight
    this.onClose = options.onClose
    this.onHide = options.onHide
    this.onRequestRender = options.onRequestRender
    this.buffer.setLines(this.buildBufferLines())
  }

  handleInput(data: string): void {
    if (isCtrlC(data)) {
      this.close()
      return
    }

    if (isHideViewer(data)) {
      this.onHide()
      return
    }

    if (this.mode === "comment") {
      this.commentPrompt.handleInput(data)
      this.invalidateAndRender()
      return
    }

    if (this.mode === "search") {
      this.searchPrompt.handleInput(data)
      this.invalidateAndRender()
      return
    }

    this.handleViewInput(data)
  }

  render(width: number, height?: number): string[] {
    const frameWidth = Math.max(0, width)
    const innerWidth = Math.max(10, width)
    const top = [
      borderLine(this.theme, frameWidth),
      this.renderHeader(innerWidth),
      separatorLine(this.theme, innerWidth),
    ]
    const bottom = [
      separatorLine(this.theme, innerWidth),
      ...this.renderFooter(innerWidth),
      borderLine(this.theme, frameWidth),
    ]
    const targetHeight =
      height ?? top.length + this.visibleHeight + bottom.length
    const bodyHeight = Math.max(0, targetHeight - top.length - bottom.length)
    this.visibleHeight = Math.max(1, bodyHeight)
    if (bodyHeight > 0) this.buffer.ensureVisible(bodyHeight)

    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedHeight === targetHeight
    ) {
      return this.cachedLines
    }

    const body = this.renderBody(innerWidth, bodyHeight)
    while (body.length < bodyHeight) body.push("")

    const framedLines = this.fitToWidth([...top, ...body, ...bottom], width)
    this.cachedWidth = width
    this.cachedHeight = targetHeight
    this.cachedLines = framedLines
    return framedLines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedHeight = undefined
    this.cachedLines = undefined
  }

  updateFile(file: ReviewFile): void {
    if (
      file.content === this.file.content &&
      file.status === this.file.status
    ) {
      this.file = file
      return
    }

    this.file = file
    this.buffer.setLines(this.buildBufferLines())
    this.visualSelection.clamp(this.buffer.length)
    this.buffer.ensureVisible(this.visibleHeight)
    this.invalidate()
  }

  private buildBufferLines() {
    return highlightForPath(this.file.content, this.file.path, this.theme).map(
      (line, index) => ({ id: String(index + 1), text: line, payload: line }),
    )
  }

  private handleViewInput(data: string): void {
    if (this.handleViewControlInput(data)) return
    if (this.handleViewNavigationInput(data)) return
    this.handleViewActionInput(data)
  }

  private handleViewControlInput(data: string): boolean {
    if (!isEscape(data) && data !== "q") return false

    if (isEscape(data) && this.visualSelection.active) {
      this.exitVisualMode()
    } else if (isEscape(data) && this.searchQuery) {
      this.clearSearch()
    } else {
      this.close()
    }
    return true
  }

  private handleViewNavigationInput(data: string): boolean {
    const halfPage = Math.max(1, Math.floor(this.visibleHeight / 2))

    if (isUp(data)) this.moveBy(-1)
    else if (isDown(data)) this.moveBy(1)
    else if (isHalfPageUp(data)) this.moveByCentered(-halfPage)
    else if (isHalfPageDown(data)) this.moveByCentered(halfPage)
    else if (isTop(data)) this.moveTo(1)
    else if (isBottom(data)) this.moveTo(this.lineCount())
    else return false

    return true
  }

  private handleViewActionInput(data: string): void {
    if (data === "v") this.toggleVisualMode()
    else if (data === "c" || matchesKey(data, "enter")) {
      this.startCommentInput()
    } else if (data === "/") this.startSearchInput()
    else if (data === "n") this.moveToSearchMatch(1)
    else if (data === "N") this.moveToSearchMatch(-1)
    else if (data === "x") {
      this.exitVisualMode()
      this.removeSelectedComment()
    } else if (data === "C") this.clearComments()
    else if (data === "y") this.copyCurrentPath()
  }

  private renderHeader(width: number): string {
    const title = `${this.file.kind} ${this.file.path}`
    const status = this.file.status === "streaming" ? "streaming, " : ""
    const visual = this.visualSelection.active ? "VISUAL LINE, " : ""
    const meta = `${visual}${status}${this.lineCount()} lines, ${this.comments.size} comments`
    return renderHeader(this.theme, title, meta, width)
  }

  private renderBody(width: number, height: number): string[] {
    if (height === 0) return []

    const numberWidth = String(this.lineCount()).length
    const lines: string[] = []

    for (const { index, line } of this.buffer.visibleLines(height)) {
      const renderedLines = this.renderLine(
        index + 1,
        line.payload,
        numberWidth,
        width,
      )
      lines.push(...renderedLines.slice(0, height - lines.length))
      if (lines.length >= height) break
    }

    return lines
  }

  private renderLine(
    lineNumber: number,
    content: string,
    numberWidth: number,
    width: number,
  ): string[] {
    const isSelected = this.isLineSelected(lineNumber)
    const hasComment = this.comments.hasAt(this.commentScope(), lineNumber)
    const lineKind = this.getLineKind(lineNumber)
    const cursor =
      lineNumber === this.selectedLine ? this.theme.fg("accent", ">") : " "
    const marker = this.renderLineMarker(lineKind, hasComment)
    const lineNumberText = String(lineNumber).padStart(numberWidth)
    const gutter = `${cursor}${marker} ${this.theme.fg("muted", lineNumberText)} │ `
    const continuationGutter = " ".repeat(visibleWidth(gutter))
    const contentWidth = Math.max(1, width - visibleWidth(gutter))
    const decoratedContent = this.decorateContent(content, lineKind)
    const renderedContent = this.searchQuery
      ? decorateSearchMatches(
          decoratedContent,
          this.searchQuery,
          this.theme,
          isSelected ? this.theme.getBgAnsi("selectedBg") : RESET_BG,
        )
      : decoratedContent
    const wrappedContent = wrapTextWithAnsi(renderedContent, contentWidth)
    const contentLines = wrappedContent.length > 0 ? wrappedContent : [""]
    const renderedLines = contentLines.map((contentLine, index) =>
      truncateToWidth(
        `${index === 0 ? gutter : continuationGutter}${contentLine}`,
        width,
        "",
      ),
    )

    if (!isSelected) return renderedLines

    return renderedLines.map((line) => fillSelected(this.theme, line, width))
  }

  private getLineKind(lineNumber: number): ReviewLineKind | undefined {
    return (
      this.file.changedLines?.get(lineNumber) ??
      (this.file.kind === "write" ? "added" : undefined)
    )
  }

  private renderLineMarker(
    lineKind: ReviewLineKind | undefined,
    hasComment: boolean,
  ): string {
    if (hasComment) return this.theme.fg("warning", "●")
    if (lineKind === "added") return this.theme.fg("success", "+")
    if (lineKind === "changed") return this.theme.fg("warning", "~")
    if (lineKind === "removed") return this.theme.fg("error", "-")
    return " "
  }

  private decorateContent(
    content: string,
    _lineKind: ReviewLineKind | undefined,
  ): string {
    return content
  }

  private renderFooter(width: number): string[] {
    if (this.mode === "comment") {
      const prompt = this.theme.fg(
        "warning",
        `Comment ${this.formatCommentRange(this.pendingCommentRange ?? this.currentCommentRange())}`,
      )
      return [
        truncateToWidth(prompt, width, ""),
        ...this.commentPrompt.render(width),
        this.theme.fg("dim", "enter save · esc cancel"),
      ]
    }

    if (this.mode === "search") {
      const visual = this.visualSelection.active ? " · VISUAL LINE" : ""
      return [
        this.theme.fg("warning", `Search${visual}`),
        ...this.searchPrompt.render(width),
        this.theme.fg("dim", "enter search · esc clear"),
      ]
    }

    const visualRange = this.visualSelection.range(this.buffer.cursorIndex)
    const position = `${this.selectedLine}/${this.lineCount()}`
    const status = visualRange
      ? this.theme.fg(
          "accent",
          `VISUAL LINE ${visualRange.startIndex + 1}-${visualRange.endIndex + 1} · ${visualRange.count} selected · cursor ${position}`,
        )
      : this.theme.fg("muted", position)
    const help = visualRange
      ? "v/esc exit · enter/c comment range · j/k extend · d/u half page · g/G top/bottom · / search · n/N next/prev"
      : "j/k move · d/u half page · g/G top/bottom · v select · / search · n/N next/prev · y copy path · enter/c comment · x remove · C clear · alt+/ hide · q close"
    return [
      truncateToWidth(`${status} ${this.theme.fg("dim", help)}`, width, ""),
      this.copyStatus
        ? this.theme.fg("success", this.copyStatus)
        : this.theme.fg(
            "dim",
            "Markers: + added · ~ changed · - removed · ● comment",
          ),
    ]
  }

  private toggleVisualMode(): void {
    this.visualSelection.toggle(this.buffer.cursorIndex)
    this.invalidateAndRender()
  }

  private exitVisualMode(): void {
    if (!this.visualSelection.active) return
    this.visualSelection.exit()
    this.invalidateAndRender()
  }

  private isLineSelected(lineNumber: number): boolean {
    const index = lineNumber - 1
    return (
      index === this.buffer.cursorIndex ||
      this.visualSelection.includes(index, this.buffer.cursorIndex)
    )
  }

  private startCommentInput(): void {
    const range = this.currentCommentRange()
    const existing = this.comments.findExact(this.commentScope(), range)
    this.pendingCommentRange = range
    this.visualSelection.exit()
    this.mode = "comment"
    this.commentPrompt.start(existing?.text ?? "", this.focused)
    this.invalidateAndRender()
  }

  private startSearchInput(): void {
    this.mode = "search"
    this.searchQuery = ""
    this.buffer.clearSearch()
    this.searchPrompt.start("", this.focused)
    this.invalidateAndRender()
  }

  private saveSearchValue(value: string): void {
    const trimmed = value.trim()
    this.searchQuery = trimmed
    this.buffer.setSearch(trimmed)
    this.mode = "view"
    this.searchPrompt.stop()
    if (trimmed) {
      this.moveToSearchMatch(1, true)
    }
    this.invalidateAndRender()
  }

  private cancelSearchInput(): void {
    this.mode = "view"
    this.clearSearch()
  }

  private clearSearch(): void {
    this.searchQuery = ""
    this.buffer.clearSearch()
    this.searchPrompt.stop({ clear: true })
    this.invalidateAndRender()
  }

  private saveCommentValue(value: string): void {
    const range = this.pendingCommentRange ?? this.currentCommentRange()
    this.comments.save(this.commentScope(), range, value, undefined)
    this.pendingCommentRange = undefined
    this.mode = "view"
    this.commentPrompt.stop({ clear: true })
    this.invalidateAndRender()
  }

  private cancelCommentInput(): void {
    this.pendingCommentRange = undefined
    this.mode = "view"
    this.commentPrompt.stop({ clear: true })
    this.invalidateAndRender()
  }

  private removeSelectedComment(): void {
    if (!this.comments.deleteAt(this.commentScope(), this.selectedLine)) return
    this.invalidateAndRender()
  }

  private copyCurrentPath(): void {
    const absolutePath = resolvePath(this.file.path, this.cwd)
    void copyTextToClipboard(absolutePath).then(
      () => {
        this.copyStatus = "Copied absolute path"
        this.invalidateAndRender()
      },
      () => {
        this.copyStatus = "Failed to copy path"
        this.invalidateAndRender()
      },
    )
  }

  private clearComments(): void {
    if (this.comments.size === 0) return
    this.comments.clear()
    this.invalidateAndRender()
  }

  private close(): void {
    this.onClose({ comments: this.getComments() })
  }

  private getComments(): ReviewComment[] {
    return this.comments.entries().map((comment) => ({
      line: comment.start,
      endLine: comment.end,
      text: comment.text,
    }))
  }

  private currentCommentRange(): LineRange {
    const visualRange = this.visualSelection.range(this.buffer.cursorIndex)
    return visualRange
      ? { start: visualRange.startIndex + 1, end: visualRange.endIndex + 1 }
      : { start: this.selectedLine, end: this.selectedLine }
  }

  private formatCommentRange(range: LineRange): string {
    return range.start === range.end
      ? `Line ${range.start}`
      : `Lines ${range.start}-${range.end}`
  }

  private commentScope(): string {
    return this.file.id
  }

  private moveBy(amount: number): void {
    this.buffer.move(amount)
    this.buffer.ensureVisible(this.visibleHeight)
    this.invalidateAndRender()
  }

  private moveByCentered(amount: number): void {
    this.buffer.moveCentered(amount, this.visibleHeight)
    this.invalidateAndRender()
  }

  private moveToSearchMatch(direction: 1 | -1, includeCurrent = false): void {
    const moved = this.buffer.search(
      direction,
      includeCurrent,
      this.visibleHeight,
    )
    if (moved) this.invalidateAndRender()
  }

  private moveTo(line: number): void {
    this.buffer.moveTo(line - 1)
    this.buffer.ensureVisible(this.visibleHeight)
    this.invalidateAndRender()
  }

  private get selectedLine(): number {
    return this.buffer.cursorIndex + 1
  }

  private lineCount(): number {
    return Math.max(1, this.buffer.length)
  }

  private invalidateAndRender(): void {
    this.invalidate()
    this.onRequestRender()
  }

  private fitToWidth(lines: string[], width: number): string[] {
    const innerWidth = Math.max(0, width)
    return lines.map((line) =>
      padToWidth(truncateToWidth(line, innerWidth, ""), innerWidth),
    )
  }
}

const ESC = String.fromCharCode(27)
const RESET_BG = `${ESC}[49m`

function isCtrlC(data: string): boolean {
  return isQuit(data) && data !== "q"
}
