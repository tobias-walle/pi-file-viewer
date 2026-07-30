import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import {
  matchesKey,
  type OverlayHandle,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import { copyTextToClipboard } from "./clipboard.js"
import {
  buildDeltaIntralineRangeCache,
  type IntralineRange,
} from "./delta-intraline.js"
import {
  discoverGitRepository,
  type GitDiffViewOptions,
  loadGitChangedFiles,
  loadGitDiffRows,
  loadGitFileRows,
} from "./git-diff.js"
import { formatGitDiffComments } from "./git-diff-comments.js"
import {
  diffRowLineNumbers,
  diffRowMarkerKind,
  fileChangeMarker,
  findRowForSourceLine,
  resolveOverviewAction,
  resolveViewerAction,
  sourceLineAtRow,
} from "./git-diff-viewer-logic.js"
import { resolvePath } from "./path.js"
import { type LineRange, RangeCommentStore } from "./range-comment-store.js"
import { decorateSearchMatches, stripAnsi } from "./search.js"
import type {
  DiffRow,
  GitChangedFile,
  GitDiffComment,
  GitDiffGuideEntry,
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
import { isHideViewer } from "./ui/keys.js"
import { type BufferLine, LineBuffer } from "./ui/line-buffer.js"
import { TextPrompt } from "./ui/text-prompt.js"
import { VisualLineSelection } from "./ui/visual-line-selection.js"
import { highlightForPath } from "./utils/markdown-highlight.js"

const OVERLAY_OPTIONS = {
  overlay: true as const,
  overlayOptions: {
    width: "100%" as const,
    maxHeight: "100%" as const,
    anchor: "top-center" as const,
  },
}

type ActiveViewer = {
  handle: OverlayHandle
  hidden: boolean
}

let activeGitDiffViewer: ActiveViewer | undefined

export function restoreGitDiffViewer(): boolean {
  if (!activeGitDiffViewer) return false
  if (activeGitDiffViewer.hidden) {
    activeGitDiffViewer.handle.setHidden(false)
    activeGitDiffViewer.hidden = false
  }
  activeGitDiffViewer.handle.focus()
  return true
}

const MIN_DIALOG_HEIGHT = 12
const MIN_OVERVIEW_HEIGHT = 5
const MAX_OVERVIEW_HEIGHT = 8
const OVERVIEW_HEIGHT_RATIO = 0.22
const MIN_VIEWER_BODY_HEIGHT = 1

const OVERVIEW_CHROME_LINES = {
  topBorder: 1,
  header: 1,
  separator: 1,
} as const

const VIEWER_CHROME_LINES = {
  header: 1,
  topSeparator: 1,
  bottomSeparator: 1,
  footer: 1,
  bottomBorder: 1,
} as const

const TEXT_INPUT_EXTRA_LINES = 2

export interface GitDiffViewerLayout {
  totalHeight: number
  overviewHeight: number
  overviewBodyHeight: number
  viewerHeight: number
  viewerBodyHeight: number
}

export function calculateGitDiffViewerLayout(
  terminalRows: number,
  inputExtraLines = 0,
): GitDiffViewerLayout {
  const totalHeight = Math.max(MIN_DIALOG_HEIGHT, terminalRows)
  const overviewHeight = Math.min(
    MAX_OVERVIEW_HEIGHT,
    Math.max(
      MIN_OVERVIEW_HEIGHT,
      Math.floor(totalHeight * OVERVIEW_HEIGHT_RATIO),
    ),
  )
  const viewerHeight = Math.max(1, totalHeight - overviewHeight)
  const overviewBodyHeight = Math.max(
    1,
    overviewHeight - chromeHeight(OVERVIEW_CHROME_LINES),
  )
  const viewerBodyHeight = Math.max(
    MIN_VIEWER_BODY_HEIGHT,
    viewerHeight - chromeHeight(VIEWER_CHROME_LINES) - inputExtraLines,
  )

  return {
    totalHeight,
    overviewHeight,
    overviewBodyHeight,
    viewerHeight,
    viewerBodyHeight,
  }
}

function chromeHeight(chrome: Record<string, number>): number {
  return Object.values(chrome).reduce((total, lines) => total + lines, 0)
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
  | {
      status: "loaded"
      root: string
      base: string
      baseLabel: string
      files: GitChangedFile[]
    }

interface PreparedDiffRows {
  viewerLines: BufferLine<DiffRow>[]
  numberWidth: number
  highlightedTextByIndex: string[]
  intralineRangesByIndex: IntralineRange[][]
}

type GitCommentMetadata = Omit<GitDiffComment, "text">

export async function openGitDiffViewer(
  ctx: ExtensionContext,
  options: GitDiffViewOptions = { scope: "all" },
): Promise<GitDiffViewerResult> {
  if (restoreGitDiffViewer()) return { comments: [] }

  let overlayHandle: OverlayHandle | undefined
  const result = await ctx.ui.custom<GitDiffViewerResult>(
    (tui, theme, _kb, done) => {
      const component = new GitDiffViewerComponent({
        cwd: ctx.sessionManager.getCwd() || ctx.cwd,
        compareRef: options.compareRef,
        scope: options.scope,
        guideEntries: options.guideEntries,
        theme,
        terminalRows: tui.terminal.rows,
        onClose: done,
        onHide: () => {
          if (!overlayHandle) return
          overlayHandle.setHidden(true)
          overlayHandle.unfocus()
          if (activeGitDiffViewer) activeGitDiffViewer.hidden = true
          ctx.ui.notify(
            "Diff viewer hidden. Run /view-diff to show it again.",
            "info",
          )
        },
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
        dispose: () => {
          component.dispose()
          if (activeGitDiffViewer?.handle === overlayHandle) {
            activeGitDiffViewer = undefined
          }
        },
      }
    },
    {
      ...OVERLAY_OPTIONS,
      onHandle: (handle) => {
        overlayHandle = handle
        activeGitDiffViewer = { handle, hidden: false }
      },
    },
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
  compareRef?: string
  scope: GitDiffViewOptions["scope"]
  guideEntries?: GitDiffGuideEntry[]
  theme: Theme
  terminalRows: number
  onClose: (result: GitDiffViewerResult) => void
  onHide: () => void
  onRequestRender: () => void
}

class GitDiffViewerComponent {
  private state: TopState = { status: "loading" }
  private focus: FocusPane = "viewer"
  private inputMode: InputMode = "normal"
  private overviewBuffer = new LineBuffer<GitChangedFile>()
  private viewerBuffer = new LineBuffer<DiffRow>()
  private visualSelection = new VisualLineSelection()
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
  private preparedRowsCache = new WeakMap<DiffRow[], PreparedDiffRows>()
  private viewerPositions = new Map<string, { line: number; scroll: number }>()
  private pendingViewerLines = new Map<string, number>()
  private viewerLineAnchor:
    | { key: string; sourceLine: number; cursorIndex: number }
    | undefined
  private requestId = 0
  private comments = new RangeCommentStore<GitCommentMetadata>()
  private pendingComment?: {
    scope: string
    range: LineRange
    metadata: GitCommentMetadata
  }
  private copyStatus = ""
  private cached?: { width: number; lines: string[] }
  private spinner?: NodeJS.Timeout
  private guideEntriesByPath = new Map<string, GitDiffGuideEntry>()

  constructor(private options: Options) {
    this.guideEntriesByPath = new Map(
      options.guideEntries?.map((entry) => [entry.path, entry]),
    )
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
    const height = this.layout().totalHeight
    const lines = this.renderContent(Math.max(20, width), height)
    this.cached = { width, lines }
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.close()
      return
    }
    if (isHideViewer(data)) {
      this.options.onHide()
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
    const discovery = await discoverGitRepository(
      this.options.cwd,
      this.options.compareRef,
      this.options.scope,
    )
    if (discovery.status !== "ok") {
      this.state = { status: discovery.status, message: discovery.message }
      this.stopSpinner()
      return this.requestRender()
    }
    try {
      const files = this.orderFilesByGuide(
        await loadGitChangedFiles(
          discovery.root,
          discovery.base,
          this.options.scope,
        ),
      )
      this.state = {
        status: "loaded",
        root: discovery.root,
        base: discovery.base,
        baseLabel: discovery.baseLabel,
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

  private compareLabel(): string {
    if (this.state.status === "loaded") return this.state.baseLabel
    if (this.options.scope === "unstaged") return "index"
    return this.options.compareRef ?? "HEAD"
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
          ? `Please wait while changes compared with ${this.compareLabel()} are loaded.`
          : this.state.message,
      )
    if (this.state.files.length === 0)
      return this.renderStateCard(
        width,
        height,
        "Git changes",
        "Working tree clean",
        `No changes found compared with ${this.compareLabel()}.`,
      )

    return [...this.renderOverview(width), ...this.renderViewer(width)]
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

  private renderOverview(width: number): string[] {
    const files = this.filteredFiles()
    const lines = [
      this.borderLine(width),
      this.renderHeader(
        "Git changes",
        `${files.length} files vs ${this.compareLabel()}`,
      ),
      this.separatorLine(width),
    ]
    const bodyHeight = this.layout().overviewBodyHeight
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
    const rank = this.guideEntry(file)?.rank
    const rankText = rank
      ? this.theme.fg("muted", `#${String(rank).padStart(2, "0")} `)
      : ""
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
    const prefix = `${rankText}${status} `
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

  private renderViewer(width: number): string[] {
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
        `${this.visualSelection.active ? "VISUAL LINE " : ""}${this.viewMode} ${this.selectedFile + 1}/${this.filteredFiles().length} ${stripAnsi(this.renderStats(file))} ${this.commentsForFile(file.id)} comments`,
      ),
      this.separatorLine(width),
    ]
    const fullBodyHeight = this.layout().viewerBodyHeight
    const guideLines = this.renderGuideLines(
      file,
      width,
      Math.max(0, fullBodyHeight - MIN_VIEWER_BODY_HEIGHT),
    )
    lines.push(...guideLines)
    const bodyHeight = fullBodyHeight - guideLines.length
    const bodyEnd = lines.length + bodyHeight
    const prepared = this.preparedRows(file, rows)
    this.setViewerLines(prepared.viewerLines)
    this.applyPendingViewerLine(rows, bodyHeight)
    this.ensureViewerVisible(rows, bodyHeight)
    const numberWidth = prepared.numberWidth
    let rowIndex = this.viewerScroll
    while (lines.length < bodyEnd) {
      const row = rows[rowIndex]
      if (!row) {
        lines.push("")
        rowIndex++
        continue
      }

      const renderedRows = this.renderDiffRow(
        file,
        prepared,
        row,
        rowIndex,
        numberWidth,
        width,
      )
      lines.push(...renderedRows.slice(0, bodyEnd - lines.length))
      rowIndex++
    }
    lines.push(this.separatorLine(width))
    lines.push(...this.renderFooter(width, file))
    lines.push(this.borderLine(width))
    return lines
  }

  private renderDiffRow(
    file: GitChangedFile,
    prepared: PreparedDiffRows,
    row: DiffRow,
    rowIndex: number,
    numberWidth: number,
    width: number,
  ): string[] {
    const index = rowIndex + 1
    const active = this.focus === "viewer" && index === this.viewerLine
    const selected = this.isViewerRowSelected(rowIndex)
    if (row.kind === "card") {
      const text =
        index === 1
          ? center(this.theme.bold(row.text), width)
          : index === 2 && row.message
            ? center(this.theme.fg("dim", row.message), width)
            : ""
      return [selected ? this.fillSelected(text, width) : text]
    }
    const marker = this.renderDiffMarker(
      row,
      this.comments.hasAt(this.commentScope(file), index),
    )
    const cursor = active ? this.theme.fg("accent", ">") : " "
    const { oldText, newText } = diffRowLineNumbers(row, numberWidth)
    const gutter = `${cursor}${marker} ${this.theme.fg("muted", oldText)} ${this.theme.fg("muted", newText)} │ `
    const rowBg = this.diffRowBg(row)
    const content = this.decorateRow(prepared, row, rowIndex, rowBg)
    const restoreBg = selected
      ? this.theme.getBgAnsi("selectedBg")
      : (rowBg ?? RESET_BG)
    const withSearch = this.searchQuery
      ? decorateSearchMatches(content, this.searchQuery, this.theme, restoreBg)
      : content
    const contentWidth = Math.max(1, width - visibleWidth(gutter))
    const wrapped = wrapTextWithAnsi(withSearch, contentWidth)
    const contentLines = wrapped.length > 0 ? wrapped : [""]
    return contentLines.map((contentLine, wrapIndex) => {
      const line = `${wrapIndex === 0 ? gutter : " ".repeat(visibleWidth(gutter))}${RESET_FG}${contentLine}`
      return this.renderDiffRowBackground(
        truncateToWidth(line, width, ""),
        width,
        selected,
        rowBg,
      )
    })
  }

  private isViewerRowSelected(rowIndex: number): boolean {
    if (this.focus !== "viewer") return false
    return (
      rowIndex === this.viewerBuffer.cursorIndex ||
      this.visualSelection.includes(rowIndex, this.viewerBuffer.cursorIndex)
    )
  }

  private renderDiffMarker(row: DiffRow, hasComment: boolean): string {
    const markerKind = diffRowMarkerKind(row, hasComment)
    if (markerKind === "comment") return this.theme.fg("warning", "●")
    if (row.kind === "file") return this.renderFileChangeMarker(row)
    if (markerKind === "added") return "+"
    if (markerKind === "removed") return "-"
    if (markerKind === "hunk") return this.theme.fg("accent", "@")
    return " "
  }

  private renderFileChangeMarker(row: DiffRow): string {
    const marker = fileChangeMarker(row)
    return marker ? this.theme.fg(marker.color, marker.text) : " "
  }

  private renderGuideLines(
    file: GitChangedFile,
    width: number,
    maxLines: number,
  ): string[] {
    const guide = this.guideEntry(file)
    if (!guide || maxLines <= 0) return []

    const label = `Guide #${String(guide.rank).padStart(2, "0")}: `
    const text = `${this.theme.fg("accent", label)}${this.theme.fg("dim", guide.reason)}`
    const wrapped = wrapTextWithAnsi(text, width)
    const lines = wrapped.slice(0, Math.min(2, maxLines))
    if (wrapped.length > lines.length && lines.length > 0) {
      const lastIndex = lines.length - 1
      lines[lastIndex] =
        `${truncateToWidth(lines[lastIndex] ?? "", Math.max(1, width - 1), "")}…`
    }
    return lines
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
        this.theme.fg(
          "warning",
          `Search ${file.path}${this.visualSelection.active ? " · VISUAL LINE" : ""}`,
        ),
        ...this.searchPrompt.render(width),
        this.theme.fg("dim", "enter search · esc clear"),
      ]
    if (this.inputMode === "comment")
      return [
        this.theme.fg(
          "warning",
          `Comment ${this.pendingComment?.metadata.location ?? file.path}`,
        ),
        ...this.commentPrompt.render(width),
        this.theme.fg("dim", "enter save · esc cancel"),
      ]
    const visualRange = this.visualSelection.range(
      this.viewerBuffer.cursorIndex,
    )
    if (this.focus === "viewer" && visualRange) {
      const status = `VISUAL LINE rows ${visualRange.startIndex + 1}-${visualRange.endIndex + 1} · ${visualRange.count} selected · cursor ${this.viewerLine}/${this.viewerBuffer.length}`
      const help =
        "v/esc exit  c comment range  j/k extend  d/u half page  g/G top/bottom  / search  n/N next/prev"
      const suffix = this.copyStatus || help
      return [
        `${this.theme.fg("accent", status)} ${this.theme.fg(this.copyStatus ? "success" : "dim", suffix)}`,
      ]
    }

    const toggleHint = this.viewMode === "diff" ? "t file" : "t diff"
    const help =
      this.focus === "viewer"
        ? ` j/k move  d/u half page  g/G top/bottom  v select  tab next  shift-tab prev  / search  ${toggleHint}  y copy path  c comment  alt+/ hide  q close `
        : " j/k files  d/u scroll viewer  / filter  n/N next/prev  y copy path  enter focus viewer  alt+/ hide  q close "
    return [
      this.theme.fg(
        this.copyStatus ? "success" : "dim",
        this.copyStatus || help,
      ),
    ]
  }

  private handleOverviewInput(data: string): void {
    const files = this.filteredFiles()
    const action = resolveOverviewAction(data, {
      hasFilter: this.overviewBuffer.hasSearch(),
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
      this.scrollViewerPage(action.delta, this.currentRows())
    else if (action.type === "startFilter") this.startFilter()
    else if (action.type === "moveOverviewSearch")
      this.moveOverviewSearch(action.delta)
    else if (action.type === "selectFile")
      this.selectFile(this.selectedFile + action.delta, files)
    else if (action.type === "selectFileAbsolute")
      this.selectFile(action.index, files)
    else if (action.type === "copyPath") this.copyCurrentPath()
  }

  private handleViewerInput(data: string): void {
    const rows = this.currentRows()
    const action = resolveViewerAction(data, {
      hasSearch: this.viewerBuffer.hasSearch(),
      visualMode: this.visualSelection.active,
      half: Math.max(1, Math.floor(this.viewerHeight() / 2)),
      lastLine: rows.length,
    })
    this.runViewerAction(action, rows)
  }

  private runViewerAction(
    action: ReturnType<typeof resolveViewerAction>,
    rows: DiffRow[],
  ): void {
    if (this.runViewerMovementAction(action, rows)) return

    if (action.type === "close") this.close()
    else if (action.type === "clearSearch") this.cancelSearch()
    else if (action.type === "focusOverview") this.focus = "overview"
    else if (action.type === "selectFile")
      this.selectFile(this.selectedFile + action.delta, this.filteredFiles())
    else if (action.type === "startSearch") this.startSearch()
    else if (action.type === "visualMode") this.runVisualAction(action.action)
    else if (action.type === "toggleViewMode") this.toggleViewMode()
    else if (action.type === "startComment") {
      this.startComment()
    } else if (action.type === "removeComment") {
      this.exitVisualMode()
      this.removeComment()
    } else if (action.type === "clearComments") this.clearComments()
    else if (action.type === "copyPath") this.copyCurrentPath()
  }

  private runViewerMovementAction(
    action: ReturnType<typeof resolveViewerAction>,
    rows: DiffRow[],
  ): boolean {
    if (action.type === "moveViewer")
      this.moveViewer(this.viewerLine + action.delta, rows)
    else if (action.type === "moveViewerPage")
      this.scrollViewerPage(action.delta, rows)
    else if (action.type === "moveViewerAbsolute")
      this.moveViewer(action.line, rows)
    else if (action.type === "moveSearch") this.moveSearch(action.delta)
    else return false
    return true
  }

  private runVisualAction(action: "toggle" | "exit"): void {
    if (action === "toggle") this.toggleVisualMode()
    else this.exitVisualMode()
  }

  private ensureCurrentLoaded(): void {
    const file = this.currentFile()
    if (!file || this.getLoadState(file).status !== "idle") return
    const key = this.cacheKey(file)
    const requestId = ++this.requestId
    this.cache.set(key, { status: "loading" })
    this.startSpinner()
    if (this.state.status !== "loaded") return
    const loadRows =
      this.viewMode === "diff"
        ? loadGitDiffRows(
            file,
            this.state.root,
            this.state.base,
            this.options.scope,
          )
        : loadGitFileRows(
            file,
            this.state.root,
            this.state.base,
            this.options.scope,
            this.cachedDiffRows(file),
          )
    void loadRows.then(
      (result) => {
        if (requestId > this.requestId) return
        this.preparedRows(file, result.rows)
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

  private cachedDiffRows(file: GitChangedFile): DiffRow[] | undefined {
    const state = this.cache.get(`${file.id}:diff`)
    return state?.status === "loaded" ? state.rows : undefined
  }

  private cacheKey(file: GitChangedFile): string {
    return `${file.id}:${this.viewMode}`
  }

  private filteredFiles(): GitChangedFile[] {
    if (this.state.status !== "loaded") return []
    return this.state.files
  }

  private orderFilesByGuide(files: GitChangedFile[]): GitChangedFile[] {
    if (this.guideEntriesByPath.size === 0) return files
    return [...files].sort((left, right) => {
      const leftRank = this.guideEntry(left)?.rank ?? Number.MAX_SAFE_INTEGER
      const rightRank = this.guideEntry(right)?.rank ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank
    })
  }

  private guideEntry(file: GitChangedFile): GitDiffGuideEntry | undefined {
    return this.guideEntriesByPath.get(file.path)
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

  private buildViewerLines(rows: DiffRow[]): BufferLine<DiffRow>[] {
    return rows.map((row, index) => ({
      id: row.commentKey ?? String(index),
      text: row.text,
      payload: row,
    }))
  }

  private preparedRows(
    file: GitChangedFile,
    rows: DiffRow[],
  ): PreparedDiffRows {
    const cached = this.preparedRowsCache.get(rows)
    if (cached) return cached

    const prepared: PreparedDiffRows = {
      viewerLines: this.buildViewerLines(rows),
      numberWidth: this.computeNumberWidth(rows),
      highlightedTextByIndex: rows.map((row) =>
        this.highlightDiffRowText(file, row),
      ),
      intralineRangesByIndex: buildDeltaIntralineRangeCache(rows),
    }
    this.preparedRowsCache.set(rows, prepared)
    return prepared
  }

  private setViewerLines(lines: BufferLine<DiffRow>[]): void {
    if (this.viewerBuffer.lines !== lines) this.viewerBuffer.setLines(lines)
    this.visualSelection.clamp(lines.length)
  }

  private setCurrentViewerRows(rows: DiffRow[]): void {
    const file = this.currentFile()
    if (!file) return
    this.setViewerLines(this.preparedRows(file, rows).viewerLines)
  }

  private highlightDiffRowText(file: GitChangedFile, row: DiffRow): string {
    if (
      row.kind === "file" ||
      row.kind === "context" ||
      row.kind === "added" ||
      row.kind === "removed"
    ) {
      return highlightForPath(row.text, file.path, this.theme)[0] ?? row.text
    }
    return row.text
  }

  private currentFile(): GitChangedFile | undefined {
    return this.filteredFiles()[this.selectedFile]
  }

  private copyCurrentPath(): void {
    const file = this.currentFile()
    if (!file || this.state.status !== "loaded") return

    const absolutePath = resolvePath(file.path, this.state.root)
    void copyTextToClipboard(absolutePath).then(
      () => {
        this.copyStatus = "Copied absolute path"
        this.invalidate()
        this.requestRender()
      },
      () => {
        this.copyStatus = "Failed to copy path"
        this.invalidate()
        this.requestRender()
      },
    )
  }

  private selectFile(index: number, files: GitChangedFile[]): void {
    if (files.length === 0) return
    this.exitVisualMode()
    this.saveViewerPosition()
    this.selectedFile = (index + files.length) % files.length
    this.restoreViewerPosition()
    this.ensureCurrentLoaded()
  }

  private moveViewer(line: number, rows: DiffRow[]): void {
    this.clearViewerLineAnchor()
    this.setCurrentViewerRows(rows)
    this.viewerBuffer.moveTo(line - 1)
    this.viewerBuffer.ensureVisible(this.viewerHeight())
  }

  private scrollViewerPage(delta: number, rows: DiffRow[]): void {
    if (rows.length === 0) return

    this.clearViewerLineAnchor()
    this.setCurrentViewerRows(rows)

    const viewportHeight = this.viewerHeight()
    const currentTopRow = this.viewerScroll
    const nextTopRow = this.clampedViewerScroll(
      currentTopRow + delta,
      rows.length,
      viewportHeight,
    )
    const cursorScreenRow = this.cursorScreenRow(
      currentTopRow,
      rows.length,
      viewportHeight,
    )

    this.viewerScroll = nextTopRow
    this.viewerLine = nextTopRow + cursorScreenRow + 1
  }

  private clampedViewerScroll(
    scroll: number,
    rowCount: number,
    viewportHeight: number,
  ): number {
    const maxScroll = Math.max(0, rowCount - viewportHeight)
    return clamp(scroll, 0, maxScroll)
  }

  private cursorScreenRow(
    topRow: number,
    rowCount: number,
    viewportHeight: number,
  ): number {
    const cursorRow = this.viewerBuffer.cursorIndex - topRow
    const lastVisibleRow = Math.max(0, Math.min(viewportHeight, rowCount) - 1)
    return clamp(cursorRow, 0, lastVisibleRow)
  }

  private moveOverviewSearch(direction: 1 | -1, includeCurrent = false): void {
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

  private toggleVisualMode(): void {
    const file = this.currentFile()
    if (
      !file ||
      this.getLoadState(file).status !== "loaded" ||
      this.viewerBuffer.length === 0
    )
      return
    this.visualSelection.toggle(this.viewerBuffer.cursorIndex)
  }

  private exitVisualMode(): void {
    this.visualSelection.exit()
  }

  private toggleViewMode(): void {
    this.exitVisualMode()
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

    return sourceLineAtRow(this.currentRows(), this.viewerLine - 1)
  }

  private applyPendingViewerLine(rows: DiffRow[], visibleHeight: number): void {
    const file = this.currentFile()
    if (!file) return
    const key = this.cacheKey(file)
    const line = this.pendingViewerLines.get(key)
    if (line === undefined) return

    const match = findRowForSourceLine(rows, line)
    if (!match) return

    this.pendingViewerLines.delete(key)
    this.viewerBuffer.moveTo(match.index)
    this.viewerBuffer.center(visibleHeight)
    this.viewerLineAnchor = match.exact
      ? undefined
      : { key, sourceLine: line, cursorIndex: match.index }
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
    this.searchQuery = ""
    this.searchPrompt.start("")
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
    const rows = this.currentRows()
    if (!file || rows.length === 0) return

    const range = this.currentCommentRange()
    const scope = this.commentScope(file)
    const metadata = this.gitCommentMetadata(file, rows, range)
    const existing = this.comments.findExact(scope, range)
    this.pendingComment = { scope, range, metadata }
    this.exitVisualMode()
    this.inputMode = "comment"
    this.commentPrompt.start(existing?.text ?? "")
  }

  private saveComment(value: string): void {
    if (this.pendingComment) {
      const { scope, range, metadata } = this.pendingComment
      this.comments.save(scope, range, value, metadata)
    }
    this.pendingComment = undefined
    this.inputMode = "normal"
    this.commentPrompt.stop()
  }

  private commentLine(row: DiffRow): string {
    if (row.kind === "added") return `+${row.text}`
    if (row.kind === "removed") return `-${row.text}`
    return row.text
  }

  private cancelComment(): void {
    this.pendingComment = undefined
    this.inputMode = "normal"
    this.commentPrompt.stop({ clear: true })
  }
  private removeComment(): void {
    const file = this.currentFile()
    if (!file) return
    this.comments.deleteAt(this.commentScope(file), this.viewerLine)
  }
  private clearComments(): void {
    this.comments.clear()
  }

  private currentCommentRange(): LineRange {
    const visualRange = this.visualSelection.range(
      this.viewerBuffer.cursorIndex,
    )
    return visualRange
      ? { start: visualRange.startIndex + 1, end: visualRange.endIndex + 1 }
      : { start: this.viewerLine, end: this.viewerLine }
  }

  private commentScope(file: GitChangedFile): string {
    return `${file.id}:${this.viewMode}`
  }

  private gitCommentMetadata(
    file: GitChangedFile,
    rows: DiffRow[],
    range: LineRange,
  ): GitCommentMetadata {
    const selectedRows = rows.slice(range.start - 1, range.end)
    const locations = selectedRows
      .map((row) => this.gitRowLocation(row))
      .filter((location) => location !== undefined)
    const first = locations[0]
    const last = locations.at(-1)
    const location = this.gitRangeLocation(file, first, last)
    return {
      fileId: file.id,
      path: file.path,
      line: first?.line,
      endLine: last?.line,
      removed: first?.removed && last?.removed,
      location,
      lineContent: selectedRows.map((row) => this.commentLine(row)).join("\n"),
      order: first?.line ?? Number.MAX_SAFE_INTEGER,
    }
  }

  private gitRowLocation(
    row: DiffRow,
  ): { line: number; removed: boolean } | undefined {
    if (row.removed && row.oldLine) return { line: row.oldLine, removed: true }
    if (row.newLine) return { line: row.newLine, removed: false }
    if (row.oldLine) return { line: row.oldLine, removed: true }
    return undefined
  }

  private gitRangeLocation(
    file: GitChangedFile,
    first: { line: number; removed: boolean } | undefined,
    last: { line: number; removed: boolean } | undefined,
  ): string {
    if (!first || !last) return `${file.path}:file`
    if (first.line === last.line && first.removed === last.removed)
      return `${file.path}:${first.line}${first.removed ? " (removed)" : ""}`
    if (first.removed === last.removed)
      return `${file.path}:${first.line}-${last.line}${first.removed ? " (removed)" : ""}`
    const startSide = first.removed ? "old" : "new"
    const endSide = last.removed ? "old" : "new"
    return `${file.path}:${startSide} ${first.line}-${endSide} ${last.line}`
  }

  private getComments(): GitDiffComment[] {
    return this.comments.entries().map((comment) => ({
      ...comment.metadata,
      text: comment.text,
    }))
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
    return this.comments
      .entries()
      .filter((comment) => comment.metadata.fileId === fileId).length
  }
  private overviewHeight(): number {
    return this.layout().overviewBodyHeight
  }
  private viewerHeight(): number {
    return this.layout().viewerBodyHeight
  }
  private layout(): GitDiffViewerLayout {
    return calculateGitDiffViewerLayout(
      this.options.terminalRows,
      this.inputExtraLines(),
    )
  }
  private inputExtraLines(): number {
    return this.inputMode === "filter" ||
      this.inputMode === "search" ||
      this.inputMode === "comment"
      ? TEXT_INPUT_EXTRA_LINES
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

  private computeNumberWidth(rows: DiffRow[]): number {
    return Math.max(
      1,
      String(Math.max(...rows.map((row) => row.newLine ?? row.oldLine ?? 0), 1))
        .length,
    )
  }

  private decorateRow(
    prepared: PreparedDiffRows,
    row: DiffRow,
    rowIndex: number,
    rowBg: string | undefined,
  ): string {
    if (row.kind === "hunk") return this.theme.fg("accent", row.text)
    const highlighted = prepared.highlightedTextByIndex[rowIndex] ?? row.text
    const ranges = prepared.intralineRangesByIndex[rowIndex] ?? []
    const highlightBg = this.diffIntralineBg(row)
    return ranges.length > 0 && highlightBg && rowBg
      ? decorateVisibleRanges(highlighted, ranges, highlightBg, rowBg)
      : highlighted
  }

  private diffIntralineBg(row: DiffRow): string | undefined {
    if (row.kind === "added") return diffAddedHighlightBg(this.theme)
    if (row.kind === "removed") return diffRemovedHighlightBg(this.theme)
    return undefined
  }

  private diffRowBg(row: DiffRow): string | undefined {
    if (row.kind === "added") return diffAddedBg(this.theme)
    if (row.kind === "removed") return diffRemovedBg(this.theme)
    return undefined
  }

  private renderDiffRowBackground(
    line: string,
    width: number,
    selected: boolean,
    rowBg: string | undefined,
  ): string {
    if (selected) return this.fillSelected(line, width)
    const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`
    return rowBg ? `${rowBg}${padded}${RESET_BG}` : padded
  }

  private moveSearch(direction: 1 | -1, includeCurrent = false): void {
    const rows = this.currentRows()
    if (!this.searchQuery || rows.length === 0) return
    this.clearViewerLineAnchor()
    this.setCurrentViewerRows(rows)
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function decorateVisibleRanges(
  content: string,
  ranges: Array<{ start: number; end: number }>,
  highlightBg: string,
  restoreBg: string,
): string {
  let rangeIndex = 0
  let visibleIndex = 0
  let output = ""

  for (let index = 0; index < content.length; index++) {
    if (content[index] === ESC) {
      const sequenceEnd = content.indexOf("m", index)
      if (sequenceEnd >= 0) {
        output += content.slice(index, sequenceEnd + 1)
        index = sequenceEnd
        continue
      }
    }

    const range = ranges[rangeIndex]
    if (range && visibleIndex === range.start) output += highlightBg

    output += content[index]
    visibleIndex++

    if (range && visibleIndex === range.end) {
      output += restoreBg
      rangeIndex++
    }
  }

  return output
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
const RESET_FG = `${ESC}[39m`
const RESET_BG = `${ESC}[49m`

function diffAddedBg(theme: Theme): string {
  if (theme.getColorMode() === "truecolor") return `${ESC}[48;2;0;58;32m`
  return `${ESC}[48;5;22m`
}

function diffRemovedBg(theme: Theme): string {
  if (theme.getColorMode() === "truecolor") return `${ESC}[48;2;79;23;27m`
  return `${ESC}[48;5;52m`
}

function diffAddedHighlightBg(theme: Theme): string {
  if (theme.getColorMode() === "truecolor") return `${ESC}[48;2;0;92;50m`
  return `${ESC}[48;5;28m`
}

function diffRemovedHighlightBg(theme: Theme): string {
  if (theme.getColorMode() === "truecolor") return `${ESC}[48;2;112;31;36m`
  return `${ESC}[48;5;88m`
}
