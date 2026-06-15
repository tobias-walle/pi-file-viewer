import type { Theme } from "@earendil-works/pi-coding-agent"
import {
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import { copyTextToClipboard } from "./clipboard.js"
import { CommentStore } from "./comment-store.js"
import { resolvePath } from "./path.js"
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
  isQuit,
  isTop,
  isUp,
} from "./ui/keys.js"
import { LineBuffer } from "./ui/line-buffer.js"
import { TextPrompt } from "./ui/text-prompt.js"
import { highlightForPath } from "./utils/markdown-highlight.js"

type Mode = "view" | "comment" | "search"

interface FileViewerComponentOptions {
  file: ReviewFile
  cwd: string
  theme: Theme
  visibleHeight: number
  onClose: (result: FileViewerResult) => void
  onRequestRender: () => void
}

export class FileViewerComponent implements Focusable {
  private file: ReviewFile
  private cwd: string
  private theme: Theme
  private visibleHeight: number
  private onClose: (result: FileViewerResult) => void
  private onRequestRender: () => void
  private comments = new CommentStore<number>()
  private buffer = new LineBuffer<string>()
  private cachedWidth?: number
  private cachedBodyHeight?: number
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
    this.onRequestRender = options.onRequestRender
    this.buffer.setLines(this.buildBufferLines())
  }

  handleInput(data: string): void {
    if (isCtrlC(data)) {
      this.close()
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
    const innerWidth = Math.max(10, width)
    const bodyHeight = Math.max(5, (height ?? 30) - 7)
    this.visibleHeight = bodyHeight
    this.buffer.ensureVisible(bodyHeight)

    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedBodyHeight === bodyHeight
    ) {
      return this.cachedLines
    }

    const lines: string[] = []
    lines.push(this.renderHeader(innerWidth))
    lines.push(separatorLine(this.theme, innerWidth))
    lines.push(...this.renderBody(innerWidth, bodyHeight))

    while (lines.length < bodyHeight + 2) {
      lines.push("")
    }

    lines.push(separatorLine(this.theme, innerWidth))
    lines.push(...this.renderFooter(innerWidth))

    const borderedLines = this.addHorizontalBorder(lines, width)
    this.cachedWidth = width
    this.cachedBodyHeight = bodyHeight
    this.cachedLines = borderedLines
    return borderedLines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedBodyHeight = undefined
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

    if (isEscape(data) && this.searchQuery) {
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
    if (data === "c" || matchesKey(data, "enter")) this.startCommentInput()
    else if (data === "/") this.startSearchInput()
    else if (data === "n") this.moveToSearchMatch(1)
    else if (data === "N") this.moveToSearchMatch(-1)
    else if (data === "x") this.removeSelectedComment()
    else if (data === "C") this.clearComments()
    else if (data === "y") this.copyCurrentPath()
  }

  private renderHeader(width: number): string {
    const title = `${this.file.kind} ${this.file.path}`
    const status = this.file.status === "streaming" ? "streaming, " : ""
    const meta = `${status}${this.lineCount()} lines, ${this.comments.size} comments`
    return renderHeader(this.theme, title, meta, width)
  }

  private renderBody(width: number, height: number): string[] {
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
    const isSelected = lineNumber === this.selectedLine
    const hasComment = this.comments.has(lineNumber)
    const lineKind = this.getLineKind(lineNumber)
    const cursor = isSelected ? this.theme.fg("accent", ">") : " "
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
        `Comment Line ${this.selectedLine}`,
      )
      return [
        truncateToWidth(prompt, width, ""),
        ...this.commentPrompt.render(width),
        this.theme.fg("dim", "enter save · esc cancel"),
      ]
    }

    if (this.mode === "search") {
      return [
        this.theme.fg("warning", "Search"),
        ...this.searchPrompt.render(width),
        this.theme.fg("dim", "enter search · esc clear"),
      ]
    }

    const position = `${this.selectedLine}/${this.lineCount()}`
    const help =
      "j/k move · d/u half page · g/G top/bottom · / search · n/N next/prev · y copy path · enter/c comment · x remove · C clear · q close"
    return [
      truncateToWidth(
        `${this.theme.fg("muted", position)} ${this.theme.fg("dim", help)}`,
        width,
        "",
      ),
      this.copyStatus
        ? this.theme.fg("success", this.copyStatus)
        : this.theme.fg(
            "dim",
            "Markers: + added · ~ changed · - removed · ● comment",
          ),
    ]
  }

  private startCommentInput(): void {
    this.mode = "comment"
    this.commentPrompt.start(
      this.comments.get(this.selectedLine) ?? "",
      this.focused,
    )
    this.invalidateAndRender()
  }

  private startSearchInput(): void {
    this.mode = "search"
    this.searchPrompt.start(this.searchQuery, this.focused)
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
    this.comments.save(this.selectedLine, value)
    this.mode = "view"
    this.commentPrompt.stop({ clear: true })
    this.invalidateAndRender()
  }

  private cancelCommentInput(): void {
    this.mode = "view"
    this.commentPrompt.stop({ clear: true })
    this.invalidateAndRender()
  }

  private removeSelectedComment(): void {
    if (!this.comments.delete(this.selectedLine)) return
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
    return this.comments.entries().map(([line, text]) => ({ line, text }))
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

  private addHorizontalBorder(lines: string[], width: number): string[] {
    const innerWidth = Math.max(0, width)
    const result = [borderLine(this.theme, innerWidth)]

    for (const line of lines) {
      const text = truncateToWidth(line, innerWidth, "")
      result.push(padToWidth(text, innerWidth))
    }

    result.push(borderLine(this.theme, innerWidth))
    return result
  }
}

const ESC = String.fromCharCode(27)
const RESET_BG = `${ESC}[49m`

function isCtrlC(data: string): boolean {
  return isQuit(data) && data !== "q"
}
