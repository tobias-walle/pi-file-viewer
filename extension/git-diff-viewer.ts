import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent"
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui"
import { CommentStore } from "./comment-store.js"
import {
  discoverGitRepository,
  loadGitChangedFiles,
  loadGitDiffRows,
  loadGitFileRows,
} from "./git-diff.js"
import { formatGitDiffComments } from "./git-diff-comments.js"
import {
  buildGitDiffComments,
  diffRowLineNumbers,
  diffRowMarkerKind,
  resolveOverviewAction,
  resolveViewerAction,
} from "./git-diff-viewer-logic.js"
import { decorateSearchMatches, stripAnsi } from "./search.js"
import type {
  DiffRow,
  GitChangedFile,
  GitDiffComment,
  GitDiffLoadResult,
  GitDiffViewerResult,
} from "./types.js"
import {
  center,
  borderLine as renderBorderLine,
  renderHeader as renderFrameHeader,
  fillSelected as renderSelected,
  separatorLine as renderSeparatorLine,
  shortenLeft,
} from "./ui/frame.js"
import { LineBuffer } from "./ui/line-buffer.js"
import { TextPrompt } from "./ui/text-prompt.js"
import { highlightForPath } from "./utils/markdown-highlight.js"

const OVERLAY_OPTIONS = {
  overlay: true as const,
  overlayOptions: {
    width: "100%" as const,
    maxHeight: "85%" as const,
    anchor: "bottom-center" as const,
  },
}

type FocusPane = "overview" | "viewer"
type ViewMode = "diff" | "file"
type InputMode = "normal" | "filter" | "search" | "comment"
type LoadState =
  | { status: "idle" | "loading" }
  | {
      status: "loaded"
      loadStatus: GitDiffLoadResult["status"]
      rows: DiffRow[]
    }
  | { status: "error"; message: string }
type TopState =
  | { status: "loading" }
  | { status: "not-repo"; message: string }
  | { status: "error"; message: string }
  | { status: "loaded"; root: string; base: string; files: GitChangedFile[] }

export async function openGitDiffViewer(
  ctx: ExtensionContext,
): Promise<GitDiffViewerResult> {
  const result = await ctx.ui.custom<GitDiffViewerResult>(
    (tui, theme, _kb, done) => {
      const component = new GitDiffViewerComponent({
        cwd: ctx.sessionManager.getCwd() || ctx.cwd,
        theme,
        terminalRows: tui.terminal.rows,
        onClose: done,
        onRequestRender: () => tui.requestRender(),
      })
      return {
        render: (width: number) => {
          component.updateTerminalRows(tui.terminal.rows)
          return component.render(width)
        },
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data)
          tui.requestRender()
        },
        dispose: () => component.dispose(),
      }
    },
    OVERLAY_OPTIONS,
  )

  if (result.comments.length > 0) {
    const files = lastFilesForFormatting
    ctx.ui.pasteToEditor(formatGitDiffComments(files, result.comments))
  }
  return result
}

let lastFilesForFormatting: GitChangedFile[] = []

interface Options {
  cwd: string
  theme: Theme
  terminalRows: number
  onClose: (result: GitDiffViewerResult) => void
  onRequestRender: () => void
}

class GitDiffViewerComponent {
  private state: TopState = { status: "loading" }
  private focus: FocusPane = "overview"
  private inputMode: InputMode = "normal"
  private overviewBuffer = new LineBuffer<GitChangedFile>()
  private viewerBuffer = new LineBuffer<DiffRow>()
  private viewMode: ViewMode = "diff"
  private filterPrompt = new TextPrompt({
    onSubmit: (value) => this.applyFilter(value),
    onCancel: () => this.cancelFilter(),
  })
  private searchPrompt = new TextPrompt({
    onSubmit: (value) => this.applySearch(value),
    onCancel: () => this.cancelSearch(),
  })
  private commentPrompt = new TextPrompt({
    onSubmit: (value) => this.saveComment(value),
    onCancel: () => this.cancelComment(),
  })
  private cache = new Map<string, LoadState>()
  private viewerPositions = new Map<string, { line: number; scroll: number }>()
  private pendingViewerLines = new Map<string, number>()
  private viewerLineAnchor:
    | { key: string; sourceLine: number; cursorIndex: number }
    | undefined
  private requestId = 0
  private comments = new CommentStore<string>()
  private cached?: { width: number; lines: string[] }
  private spinner?: NodeJS.Timeout

  constructor(private options: Options) {
    void this.loadOverview()
  }

  private get selectedFile(): number {
    return this.overviewBuffer.cursorIndex
  }

  private set selectedFile(value: number) {
    this.overviewBuffer.cursorIndex = value
    this.overviewBuffer.clamp()
  }

  private get overviewScroll(): number {
    return this.overviewBuffer.scrollOffset
  }

  private set overviewScroll(value: number) {
    this.overviewBuffer.scrollOffset = value
    this.overviewBuffer.clamp()
  }

  private get viewerLine(): number {
    return this.viewerBuffer.cursorIndex + 1
  }

  private set viewerLine(value: number) {
    this.viewerBuffer.cursorIndex = value - 1
    this.viewerBuffer.clamp()
  }

  private get viewerScroll(): number {
    return this.viewerBuffer.scrollOffset
  }

  private set viewerScroll(value: number) {
    this.viewerBuffer.scrollOffset = value
    this.viewerBuffer.clamp()
  }

  private get searchQuery(): string {
    return this.viewerBuffer.searchQuery
  }

  private set searchQuery(value: string) {
    this.viewerBuffer.setSearch(value)
  }

  dispose(): void {
    if (this.spinner) clearInterval(this.spinner)
  }

  invalidate(): void {
    this.cached = undefined
  }

  updateTerminalRows(rows: number): void {
    if (rows === this.options.terminalRows) return
    this.options.terminalRows = rows
    this.invalidate()
  }

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.lines
    const height = Math.max(12, Math.floor(this.options.terminalRows * 0.82))
    const lines = this.renderContent(Math.max(20, width), height)
    this.cached = { width, lines }
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.close()
      return
    }
    if (this.handleTextInputMode(data)) return
    if (this.handleNotLoadedInput(data)) return

    if (this.focus === "overview") this.handleOverviewInput(data)
    else this.handleViewerInput(data)
    this.invalidate()
  }

  private handleTextInputMode(data: string): boolean {
    if (this.inputMode === "filter") this.updateFilterInput(data)
    else if (this.inputMode === "search") this.updateSearchInput(data)
    else if (this.inputMode === "comment") this.commentPrompt.handleInput(data)
    else return false

    this.invalidate()
    return true
  }

  private updateFilterInput(data: string): void {
    if (matchesKey(data, "escape")) this.cancelFilter()
    else this.filterPrompt.handleInput(data)
  }

  private updateSearchInput(data: string): void {
    if (matchesKey(data, "escape")) this.cancelSearch()
    else this.searchPrompt.handleInput(data)
  }

  private handleNotLoadedInput(data: string): boolean {
    if (this.state.status === "loaded") return false
    if (data === "q" || matchesKey(data, "escape")) this.close()
    return true
  }

  private async loadOverview(): Promise<void> {
    this.startSpinner()
    const discovery = await discoverGitRepository(this.options.cwd)
    if (discovery.status !== "ok") {
      this.state = { status: "not-repo", message: discovery.message }
      this.stopSpinner()
      return this.requestRender()
    }
    try {
      const files = await loadGitChangedFiles(discovery.root, discovery.base)
      this.state = {
        status: "loaded",
        root: discovery.root,
        base: discovery.base,
        files,
      }
      this.overviewBuffer.setLines(this.buildOverviewLines(files))
      lastFilesForFormatting = files
      this.stopSpinner()
      this.ensureCurrentLoaded()
      this.requestRender()
    } catch (error) {
      this.state = {
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to load git changes",
      }
      this.stopSpinner()
      this.requestRender()
    }
  }

  private renderContent(width: number, height: number): string[] {
    if (this.state.status !== "loaded")
      return this.renderStateCard(
        width,
        height,
        this.state.status === "loading" ? "Git changes" : "Git changes",
        this.state.status === "not-repo"
          ? "Not a Git repository"
          : this.state.status === "error"
            ? "Unable to load git changes"
            : "Loading git changes",
        this.state.status === "loading"
          ? "Please wait while uncommitted changes are loaded."
          : this.state.message,
      )
    if (this.state.files.length === 0)
      return this.renderStateCard(
        width,
        height,
        "Git changes",
        "Working tree clean",
        "No uncommitted changes found in this repository.",
      )

    const overviewHeight = Math.min(8, Math.max(5, Math.floor(height * 0.22)))
    const viewerHeight = Math.max(8, height - overviewHeight)
    return [
      ...this.renderOverview(width, overviewHeight),
      ...this.renderViewer(width, viewerHeight),
    ]
  }

  private renderStateCard(
    width: number,
    height: number,
    title: string,
    headline: string,
    message: string,
  ): string[] {
    const lines = [this.borderLine(width), this.renderHeader(title, "")]
    lines.push(this.separatorLine(width))
    const body = Math.max(3, height - 5)
    const topPad = Math.floor((body - 2) / 2)
    for (let i = 0; i < topPad; i++) lines.push("")
    lines.push(center(this.theme.bold(headline), width))
    lines.push(center(this.theme.fg("dim", message), width))
    while (lines.length < height - 3) lines.push("")
    lines.push(this.separatorLine(width))
    lines.push(this.theme.fg("dim", "q close"))
    lines.push(this.borderLine(width))
    return lines
  }

  private renderOverview(width: number, height: number): string[] {
    const files = this.filteredFiles()
    this.overviewBuffer.setLines(this.buildOverviewLines(files))
    const lines = [
      this.borderLine(width),
      this.renderHeader("Git changes", `${files.length} files`),
      this.separatorLine(width),
    ]
    const bodyHeight = Math.max(1, height - 3)
    this.ensureOverviewVisible(files, bodyHeight)
    for (let row = 0; row < bodyHeight; row++) {
      const index = this.overviewScroll + row
      const file = files[index]
      lines.push(file ? this.renderFileRow(file, index, width) : "")
    }
    return lines
  }

  private renderFileRow(
    file: GitChangedFile,
    index: number,
    width: number,
  ): string {
    const selected = index === this.selectedFile
    const selectedBg = selected ? this.theme.getBgAnsi("selectedBg") : RESET_BG
    const searchQuery = this.overviewBuffer.searchQuery
    const statusText = file.status.padEnd(2)
    const status = this.theme.fg(
      statusColor(file.status),
      searchQuery
        ? decorateSearchMatches(statusText, searchQuery, this.theme, selectedBg)
        : statusText,
    )
    const path =
      file.status === "R" && file.oldPath
        ? `${file.oldPath} -> ${file.path}`
        : file.path
    const stats = this.renderStats(file)
    const prefix = `${status} `
    const available = Math.max(
      1,
      width - visibleWidth(prefix) - visibleWidth(stats) - 2,
    )
    const pathText = shortenLeft(path, available).padEnd(available)
    const renderedPath = searchQuery
      ? decorateSearchMatches(pathText, searchQuery, this.theme, selectedBg)
      : pathText
    let line = `${prefix}${renderedPath} ${stats}`
    line = truncateToWidth(line, width, "")
    const padding = " ".repeat(Math.max(0, width - visibleWidth(line)))
    return selected
      ? this.theme.bg("selectedBg", `${line}${padding}`)
      : `${line}${padding}`
  }

  private renderViewer(width: number, height: number): string[] {
    const file = this.currentFile()
    if (!file) return []
    const state = this.getLoadState(file)
    const rows =
      state.status === "loaded"
        ? state.rows
        : [
            {
              kind: "card" as const,
              text: state.status === "loading" ? "Loading" : "Unable to load",
              message:
                state.status === "error" ? state.message : "Please wait.",
            },
          ]
    const lines = [
      this.renderHeader(
        file.path,
        `${this.viewMode} ${this.selectedFile + 1}/${this.filteredFiles().length} ${stripAnsi(this.renderStats(file))} ${this.commentsForFile(file.id)} comments`,
      ),
      this.separatorLine(width),
    ]
    const bodyHeight = Math.max(1, height - 5 - this.inputExtraLines())
    this.viewerBuffer.setLines(this.buildViewerLines(rows))
    this.applyPendingViewerLine(rows, bodyHeight)
    this.ensureViewerVisible(rows, bodyHeight)
    const numberWidth = this.numberWidth(rows)
    for (let i = 0; i < bodyHeight; i++) {
      const row = rows[this.viewerScroll + i]
      lines.push(
        row
          ? this.renderDiffRow(
              file,
              row,
              this.viewerScroll + i + 1,
              numberWidth,
              width,
            )
          : "",
      )
    }
    lines.push(this.separatorLine(width))
    lines.push(...this.renderFooter(width, file))
    lines.push(this.borderLine(width))
    return lines
  }

  private renderDiffRow(
    file: GitChangedFile,
    row: DiffRow,
    index: number,
    numberWidth: number,
    width: number,
  ): string {
    const selected = this.focus === "viewer" && index === this.viewerLine
    if (row.kind === "card") {
      const text =
        index === 1
          ? center(this.theme.bold(row.text), width)
          : index === 2 && row.message
            ? center(this.theme.fg("dim", row.message), width)
            : ""
      return selected ? this.fillSelected(text, width) : text
    }
    const commentKey = this.commentKey(file, row)
    const marker = this.renderDiffMarker(row, this.comments.has(commentKey))
    const { oldText, newText } = diffRowLineNumbers(row, numberWidth)
    const gutter = `${marker} ${this.theme.fg("muted", oldText)} ${this.theme.fg("muted", newText)} │ `
    const content = this.decorateRow(file, row)
    const withSearch = this.searchQuery
      ? decorateSearchMatches(
          content,
          this.searchQuery,
          this.theme,
          selected ? this.theme.getBgAnsi("selectedBg") : RESET_BG,
        )
      : content
    const wrapped = wrapTextWithAnsi(
      withSearch,
      Math.max(1, width - visibleWidth(gutter)),
    )
    const line = `${gutter}${wrapped[0] ?? ""}`
    return selected
      ? this.fillSelected(truncateToWidth(line, width, ""), width)
      : truncateToWidth(line, width, "")
  }

  private renderDiffMarker(row: DiffRow, hasComment: boolean): string {
    const markerKind = diffRowMarkerKind(row, hasComment)
    if (markerKind === "comment") return this.theme.fg("warning", "●")
    if (markerKind === "added") return this.theme.fg("success", "+")
    if (markerKind === "removed") return this.theme.fg("error", "-")
    if (markerKind === "hunk") return this.theme.fg("accent", "@")
    return " "
  }

  private renderFooter(width: number, file: GitChangedFile): string[] {
    if (this.inputMode === "filter")
      return [
        this.theme.fg("warning", "Search changed files"),
        ...this.filterPrompt.render(width),
        this.theme.fg("dim", "enter search · esc clear"),
      ]
    if (this.inputMode === "search")
      return [
        this.theme.fg("warning", `Search ${file.path}`),
        ...this.searchPrompt.render(width),
        this.theme.fg("dim", "enter search · esc clear"),
      ]
    if (this.inputMode === "comment")
      return [
        this.theme.fg("warning", `Comment ${this.commentLocation(file)}`),
        ...this.commentPrompt.render(width),
        this.theme.fg("dim", "enter save · esc cancel"),
      ]
    const toggleHint = this.viewMode === "diff" ? "v file" : "v diff"
    const help =
      this.focus === "viewer"
        ? ` j/k move  tab next  shift-tab prev  / search  ${toggleHint}  c comment  q close `
        : " j/k move  C-d/C-u scroll viewer  / search  n/N next/prev  enter focus viewer  q close "
    return [this.theme.fg("dim", help)]
  }

  private handleOverviewInput(data: string): void {
    const files = this.filteredFiles()
    const action = resolveOverviewAction(data, {
      hasFilter: this.overviewBuffer.hasSearch(),
      overviewHalf: Math.max(1, Math.floor(this.overviewHeight() / 2)),
      viewerHalf: Math.max(1, Math.floor(this.viewerHeight() / 2)),
      lastIndex: files.length - 1,
    })
    this.runOverviewAction(action, files)
  }

  private runOverviewAction(
    action: ReturnType<typeof resolveOverviewAction>,
    files: GitChangedFile[],
  ): void {
    if (action.type === "close") this.close()
    else if (action.type === "clearFilter") this.overviewBuffer.clearSearch()
    else if (action.type === "focusViewer") this.focus = "viewer"
    else if (action.type === "moveViewerPage")
      this.moveViewerCentered(
        this.viewerLine + action.delta,
        this.currentRows(),
      )
    else if (action.type === "startFilter") this.startFilter()
    else if (action.type === "moveOverviewSearch")
      this.moveOverviewSearch(action.delta)
    else if (action.type === "selectFile")
      this.selectFile(this.selectedFile + action.delta, files)
    else if (action.type === "selectFileAbsolute")
      this.selectFile(action.index, files)
  }

  private handleViewerInput(data: string): void {
    const rows = this.currentRows()
    const action = resolveViewerAction(data, {
      hasSearch: this.viewerBuffer.hasSearch(),
      half: Math.max(1, Math.floor(this.viewerHeight() / 2)),
      lastLine: rows.length,
    })
    this.runViewerAction(action, rows)
  }

  private runViewerAction(
    action: ReturnType<typeof resolveViewerAction>,
    rows: DiffRow[],
  ): void {
    if (action.type === "close") this.close()
    else if (action.type === "clearSearch") this.cancelSearch()
    else if (action.type === "focusOverview") this.focus = "overview"
    else if (action.type === "selectFile")
      this.selectFile(this.selectedFile + action.delta, this.filteredFiles())
    else if (action.type === "moveViewer")
      this.moveViewer(this.viewerLine + action.delta, rows)
    else if (action.type === "moveViewerPage")
      this.moveViewerCentered(this.viewerLine + action.delta, rows)
    else if (action.type === "moveViewerAbsolute")
      this.moveViewer(action.line, rows)
    else if (action.type === "startSearch") this.startSearch()
    else if (action.type === "moveSearch") this.moveSearch(action.delta)
    else if (action.type === "toggleViewMode") this.toggleViewMode()
    else if (action.type === "startComment") this.startComment()
    else if (action.type === "removeComment") this.removeComment()
    else if (action.type === "clearComments") this.clearComments()
  }

  private ensureCurrentLoaded(): void {
    const file = this.currentFile()
    if (!file || this.getLoadState(file).status !== "idle") return
    const key = this.cacheKey(file)
    const requestId = ++this.requestId
    this.cache.set(key, { status: "loading" })
    this.startSpinner()
    const loader = this.viewMode === "diff" ? loadGitDiffRows : loadGitFileRows
    if (this.state.status !== "loaded") return
    void loader(file, this.state.root, this.state.base).then(
      (result) => {
        if (requestId > this.requestId) return
        this.cache.set(key, {
          status: "loaded",
          loadStatus: result.status,
          rows: result.rows,
        })
        this.stopSpinner()
        this.invalidate()
        this.requestRender()
      },
      (error) => {
        this.cache.set(key, {
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load",
        })
        this.stopSpinner()
        this.requestRender()
      },
    )
  }

  private currentRows(): DiffRow[] {
    const file = this.currentFile()
    if (!file) return []
    const state = this.getLoadState(file)
    return state.status === "loaded" ? state.rows : []
  }

  private getLoadState(file: GitChangedFile): LoadState {
    return this.cache.get(this.cacheKey(file)) ?? { status: "idle" }
  }

  private cacheKey(file: GitChangedFile): string {
    return `${file.id}:${this.viewMode}`
  }

  private filteredFiles(): GitChangedFile[] {
    if (this.state.status !== "loaded") return []
    return this.state.files
  }

  private buildOverviewLines(files: GitChangedFile[]) {
    return files.map((file) => ({
      id: file.id,
      text: this.overviewSearchText(file),
      payload: file,
    }))
  }

  private overviewSearchText(file: GitChangedFile): string {
    const path =
      file.status === "R" && file.oldPath
        ? `${file.oldPath} -> ${file.path}`
        : file.path
    return `${file.status} ${path} -${file.removed} +${file.added}`
  }

  private buildViewerLines(rows: DiffRow[]) {
    return rows.map((row, index) => ({
      id: row.commentKey ?? String(index),
      text: row.text,
      payload: row,
    }))
  }

  private currentFile(): GitChangedFile | undefined {
    return this.filteredFiles()[this.selectedFile]
  }

  private selectFile(index: number, files: GitChangedFile[]): void {
    if (files.length === 0) return
    this.saveViewerPosition()
    this.selectedFile = (index + files.length) % files.length
    this.restoreViewerPosition()
    this.ensureCurrentLoaded()
  }

  private moveViewer(line: number, rows: DiffRow[]): void {
    this.clearViewerLineAnchor()
    this.viewerBuffer.setLines(this.buildViewerLines(rows))
    this.viewerBuffer.moveTo(line - 1)
    this.viewerBuffer.ensureVisible(this.viewerHeight())
  }

  private moveViewerCentered(line: number, rows: DiffRow[]): void {
    this.clearViewerLineAnchor()
    this.viewerBuffer.setLines(this.buildViewerLines(rows))
    this.viewerBuffer.moveTo(line - 1)
    this.viewerBuffer.center(this.viewerHeight())
  }

  private moveOverviewSearch(direction: 1 | -1, includeCurrent = false): void {
    this.overviewBuffer.setLines(this.buildOverviewLines(this.filteredFiles()))
    if (
      this.overviewBuffer.search(
        direction,
        includeCurrent,
        this.overviewHeight(),
      )
    ) {
      this.restoreViewerPosition()
      this.ensureCurrentLoaded()
    }
  }

  private toggleViewMode(): void {
    const focusedLine = this.getFocusedSourceLine()
    this.saveViewerPosition()
    this.viewMode = this.viewMode === "diff" ? "file" : "diff"
    this.restoreViewerPosition()

    if (focusedLine !== undefined) {
      const file = this.currentFile()
      if (file) this.pendingViewerLines.set(this.cacheKey(file), focusedLine)
    }

    this.ensureCurrentLoaded()
  }

  private getFocusedSourceLine(): number | undefined {
    const file = this.currentFile()
    const anchor = file ? this.viewerLineAnchor : undefined
    if (
      file &&
      anchor?.key === this.cacheKey(file) &&
      anchor.cursorIndex === this.viewerBuffer.cursorIndex
    ) {
      return anchor.sourceLine
    }

    const row = this.currentRows()[this.viewerLine - 1]
    return row?.newLine ?? row?.oldLine
  }

  private applyPendingViewerLine(rows: DiffRow[], visibleHeight: number): void {
    const file = this.currentFile()
    if (!file) return
    const key = this.cacheKey(file)
    const line = this.pendingViewerLines.get(key)
    if (line === undefined) return

    const match = this.findRowIndexForSourceLine(rows, line)
    if (!match) return

    this.pendingViewerLines.delete(key)
    this.viewerBuffer.moveTo(match.index)
    this.viewerBuffer.center(visibleHeight)
    this.viewerLineAnchor = match.exact
      ? undefined
      : { key, sourceLine: line, cursorIndex: match.index }
  }

  private findRowIndexForSourceLine(
    rows: DiffRow[],
    line: number,
  ): { index: number; exact: boolean } | undefined {
    const exactIndex = rows.findIndex((row) =>
      this.viewMode === "file"
        ? row.newLine === line || row.oldLine === line
        : row.newLine === line || row.oldLine === line,
    )
    if (exactIndex >= 0) return { index: exactIndex, exact: true }

    const nextIndex = rows.findIndex((row) => {
      const rowLine = row.newLine ?? row.oldLine
      return rowLine !== undefined && rowLine > line
    })
    if (nextIndex >= 0) return { index: nextIndex, exact: false }

    const previousIndex = findLastIndex(rows, (row) => {
      const rowLine = row.newLine ?? row.oldLine
      return rowLine !== undefined && rowLine < line
    })
    if (previousIndex >= 0) return { index: previousIndex, exact: false }

    return rows.length > 0
      ? { index: rows.length - 1, exact: false }
      : undefined
  }

  private clearViewerLineAnchor(): void {
    this.viewerLineAnchor = undefined
  }

  private saveViewerPosition(): void {
    const file = this.currentFile()
    if (!file) return
    this.viewerPositions.set(this.viewerPositionKey(file), {
      line: this.viewerLine,
      scroll: this.viewerScroll,
    })
  }

  private restoreViewerPosition(): void {
    const file = this.currentFile()
    const position = file
      ? this.viewerPositions.get(this.viewerPositionKey(file))
      : undefined
    this.viewerLine = position?.line ?? 1
    this.viewerScroll = position?.scroll ?? 0
  }

  private viewerPositionKey(file: GitChangedFile): string {
    return `${file.id}:${this.viewMode}`
  }

  private startFilter(): void {
    this.inputMode = "filter"
    this.filterPrompt.start(this.overviewBuffer.searchQuery)
  }
  private applyFilter(value: string): void {
    this.saveViewerPosition()
    this.overviewBuffer.setSearch(value)
    this.inputMode = "normal"
    this.filterPrompt.stop()
    this.moveOverviewSearch(1, true)
    this.restoreViewerPosition()
    this.ensureCurrentLoaded()
  }
  private cancelFilter(): void {
    this.saveViewerPosition()
    this.inputMode = "normal"
    this.filterPrompt.stop({ clear: true })
    this.overviewBuffer.clearSearch()
    this.selectedFile = 0
    this.restoreViewerPosition()
    this.ensureCurrentLoaded()
  }
  private startSearch(): void {
    this.inputMode = "search"
    this.searchPrompt.start(this.searchQuery)
  }
  private applySearch(value: string): void {
    this.searchQuery = value.trim()
    this.inputMode = "normal"
    this.searchPrompt.stop()
    if (this.searchQuery) this.moveSearch(1, true)
  }
  private cancelSearch(): void {
    this.inputMode = "normal"
    this.searchQuery = ""
    this.searchPrompt.stop({ clear: true })
  }

  private startComment(): void {
    const file = this.currentFile()
    const row = this.currentRows()[this.viewerLine - 1]
    if (!file || !row) return
    const key = this.commentKey(file, row)
    this.inputMode = "comment"
    this.commentPrompt.start(this.comments.get(key) ?? "")
  }

  private saveComment(value: string): void {
    const file = this.currentFile()
    const row = this.currentRows()[this.viewerLine - 1]
    if (!file || !row) return
    const key = this.commentKey(file, row)
    this.comments.save(key, value)
    this.inputMode = "normal"
    this.commentPrompt.stop()
  }

  private cancelComment(): void {
    this.inputMode = "normal"
    this.commentPrompt.stop({ clear: true })
  }
  private removeComment(): void {
    const file = this.currentFile()
    const row = this.currentRows()[this.viewerLine - 1]
    if (file && row) this.comments.delete(this.commentKey(file, row))
  }
  private clearComments(): void {
    this.comments.clear()
  }

  private commentKey(file: GitChangedFile, row: DiffRow): string {
    if (row.kind === "card") return `${file.id}\tfile\t0`
    if (row.removed && row.oldLine) return `${file.id}\told\t${row.oldLine}`
    if (row.newLine) return `${file.id}\tnew\t${row.newLine}`
    return `${file.id}\trow\t${this.viewerLine}`
  }

  private commentLocation(file: GitChangedFile): string {
    const row = this.currentRows()[this.viewerLine - 1]
    if (!row) return `${file.path}:file`
    if (row.removed && row.oldLine) return `${file.path}:${row.oldLine}`
    if (row.newLine) return `${file.path}:${row.newLine}`
    return `${file.path}:file`
  }

  private getComments(): GitDiffComment[] {
    const files = this.state.status === "loaded" ? this.state.files : []
    return buildGitDiffComments(files, this.comments.asReadonlyMap())
  }

  private close(): void {
    this.options.onClose({ comments: this.getComments() })
  }
  private requestRender(): void {
    this.invalidate()
    this.options.onRequestRender()
  }
  private get theme(): Theme {
    return this.options.theme
  }
  private borderLine(width: number): string {
    return renderBorderLine(this.theme, width)
  }

  private separatorLine(width: number): string {
    return renderSeparatorLine(this.theme, width)
  }

  private renderHeader(title: string, meta: string): string {
    return renderFrameHeader(this.theme, title, meta, 2000)
  }
  private renderStats(file: GitChangedFile): string {
    if (file.binary) return this.theme.fg("muted", "binary")
    if (file.large) return this.theme.fg("warning", "large")
    return `${this.theme.fg("error", `-${file.removed}`)} ${this.theme.fg("success", `+${file.added}`)}`
  }
  private commentsForFile(fileId: string): number {
    return this.comments.keys().filter((key) => key.startsWith(`${fileId}\t`))
      .length
  }
  private overviewHeight(): number {
    return Math.min(
      8,
      Math.max(
        5,
        Math.floor(
          Math.max(12, Math.floor(this.options.terminalRows * 0.82)) * 0.22,
        ),
      ),
    )
  }
  private viewerHeight(): number {
    return Math.max(
      1,
      Math.max(12, Math.floor(this.options.terminalRows * 0.82)) -
        this.overviewHeight() -
        4,
    )
  }
  private inputExtraLines(): number {
    return this.inputMode === "filter" ||
      this.inputMode === "search" ||
      this.inputMode === "comment"
      ? 2
      : 0
  }

  private ensureOverviewVisible(files: GitChangedFile[], height: number): void {
    if (this.selectedFile >= files.length)
      this.selectedFile = Math.max(0, files.length - 1)
    if (this.selectedFile < this.overviewScroll)
      this.overviewScroll = this.selectedFile
    if (this.selectedFile >= this.overviewScroll + height)
      this.overviewScroll = this.selectedFile - height + 1
  }

  private ensureViewerVisible(rows: DiffRow[], height: number): void {
    if (this.viewerLine > rows.length)
      this.viewerLine = Math.max(1, rows.length)
    if (this.viewerLine <= this.viewerScroll)
      this.viewerScroll = this.viewerLine - 1
    if (this.viewerLine > this.viewerScroll + height)
      this.viewerScroll = this.viewerLine - height
  }

  private numberWidth(rows: DiffRow[]): number {
    return Math.max(
      1,
      String(Math.max(...rows.map((row) => row.newLine ?? row.oldLine ?? 0), 1))
        .length,
    )
  }

  private decorateRow(file: GitChangedFile, row: DiffRow): string {
    if (row.kind === "hunk") return this.theme.fg("accent", row.text)
    const highlighted =
      row.kind === "file" || row.kind === "context" || row.kind === "added"
        ? (highlightForPath(row.text, file.path, this.theme)[0] ?? row.text)
        : row.text
    if (row.kind === "added") return this.theme.fg("success", highlighted)
    if (row.kind === "removed") return this.theme.fg("error", highlighted)
    return highlighted
  }

  private moveSearch(direction: 1 | -1, includeCurrent = false): void {
    const rows = this.currentRows()
    if (!this.searchQuery || rows.length === 0) return
    this.clearViewerLineAnchor()
    this.viewerBuffer.setLines(this.buildViewerLines(rows))
    this.viewerBuffer.search(direction, includeCurrent, this.viewerHeight())
  }

  private fillSelected(line: string, width: number): string {
    return renderSelected(this.theme, line, width)
  }
  private startSpinner(): void {
    if (!this.spinner)
      this.spinner = setInterval(() => this.requestRender(), 120)
  }
  private stopSpinner(): void {
    if (this.spinner) clearInterval(this.spinner)
    this.spinner = undefined
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}

function statusColor(
  status: GitChangedFile["status"],
): "warning" | "success" | "error" | "accent" {
  if (status === "M") return "warning"
  if (status === "D") return "error"
  if (status === "R") return "accent"
  return "success"
}

const ESC = String.fromCharCode(27)
const RESET_BG = `${ESC}[49m`
