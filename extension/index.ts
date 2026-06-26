import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent"
import {
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui"

import {
  buildEditLineKinds,
  countLogicalLines,
  type EditDetails,
  type NormalizedEditInput,
} from "./diff.js"
import { type GitDiffViewOptions, parseGitDiffViewArgs } from "./git-diff.js"
import { createGitDiffGuide } from "./git-diff-guide.js"
import { openGitDiffViewer, restoreGitDiffViewer } from "./git-diff-viewer.js"
import { resolvePath } from "./path.js"
import {
  addReviewFile,
  batchReviewFileUpdates,
  clearReviewFiles,
  getReviewFiles,
  setReviewScope,
} from "./registry.js"
import type {
  GitDiffGuideEntry,
  ReviewFile,
  ReviewFileStatus,
} from "./types.js"
import { openFileViewer, restoreFileViewer } from "./viewer.js"

const MAX_VIEW_FILE_BYTES = 5 * 1024 * 1024
const STREAMING_UPDATE_DELAY_MS = 100
const streamingUpdatesByScope = new Map<string, StreamingUpdate>()

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    activateReviewScope(ctx)
    await rebuildReviewFiles(ctx)
  })

  pi.on("session_tree", async (_event, ctx) => {
    activateReviewScope(ctx)
    await rebuildReviewFiles(ctx)
  })

  pi.on("message_update", async (event, ctx) => {
    const message = getAssistantEventMessage(event.assistantMessageEvent)
    if (!message) return
    scheduleStreamingAssistantMessage(message, ctx)
  })

  pi.on("tool_call", async (event, ctx) => {
    activateReviewScope(ctx)
    await addReviewFileFromToolInput({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      details: undefined,
      createdAt: Date.now(),
      status: "streaming",
    })
  })

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return

    activateReviewScope(ctx)
    flushStreamingAssistantMessage(getReviewScope(ctx))
    await addReviewFileFromToolInput({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      details: event.details,
      createdAt: Date.now(),
      status: "complete",
    })
  })

  pi.registerCommand("view-file", {
    description: "View a recent write/edit tool call in a reusable file viewer",
    handler: async (_args, ctx) => {
      await openFileReview(ctx)
    },
  })

  pi.registerCommand("view-diff", {
    description: "Review git changes, optionally staged or unstaged only",
    handler: async (args, ctx) => {
      await openGitDiffReview(ctx, args)
    },
  })
}

type GuideGenerationResult =
  | { status: "ok"; entries: GitDiffGuideEntry[] }
  | { status: "error"; message: string }
  | { status: "cancelled" }

async function generateGitDiffGuideForViewer(
  ctx: ExtensionContext,
  options: GitDiffViewOptions,
): Promise<GitDiffGuideEntry[] | undefined> {
  const result =
    ctx.mode === "tui"
      ? await generateGitDiffGuideWithLoader(ctx, options)
      : await generateGitDiffGuide(ctx, options)

  if (result.status === "ok") return result.entries
  if (result.status === "cancelled") ctx.ui.notify("Cancelled", "info")
  else ctx.ui.notify(result.message, "error")
  return undefined
}

async function generateGitDiffGuideWithLoader(
  ctx: ExtensionContext,
  options: GitDiffViewOptions,
): Promise<GuideGenerationResult> {
  return await ctx.ui.custom<GuideGenerationResult>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Planning review order...")
    loader.onAbort = () => done({ status: "cancelled" })

    void createGitDiffGuide(ctx, options, loader.signal).then(
      (guide) => done({ status: "ok", entries: guide.entries }),
      (error) =>
        done({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to plan review order",
        }),
    )

    return loader
  })
}

async function generateGitDiffGuide(
  ctx: ExtensionContext,
  options: GitDiffViewOptions,
): Promise<GuideGenerationResult> {
  try {
    const guide = await createGitDiffGuide(ctx, options)
    return { status: "ok", entries: guide.entries }
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error ? error.message : "Failed to plan review order",
    }
  }
}

export async function openFileReview(ctx: ExtensionContext): Promise<void> {
  if (restoreFileViewer()) return

  activateReviewScope(ctx)
  flushStreamingAssistantMessage(getReviewScope(ctx))
  await rebuildReviewFiles(ctx)
  const files = getReviewFiles()
  const cwd = getCurrentCwd(ctx)
  const file = await selectReviewFile(ctx, files, cwd)
  if (!file) return
  const hydratedFile = await hydrateReviewFileForViewing(file, cwd)
  void openFileViewer(ctx, hydratedFile).catch((error) => {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Failed to open file viewer",
      "error",
    )
  })
}

export async function openGitDiffReview(
  ctx: ExtensionContext,
  args = "",
): Promise<void> {
  if (restoreGitDiffViewer()) return

  const options = parseGitDiffViewArgs(args)
  const guideEntries = options.guide
    ? await generateGitDiffGuideForViewer(ctx, options)
    : undefined
  if (options.guide && !guideEntries) return

  void openGitDiffViewer(ctx, { ...options, guideEntries }).catch((error) => {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Failed to open diff viewer",
      "error",
    )
  })
}

function parseWriteInput(
  input: Record<string, unknown>,
): WriteToolInput | undefined {
  if (typeof input.path !== "string") return undefined
  if (typeof input.content !== "string") return undefined
  return { path: input.path, content: input.content }
}

function parseEditInput(
  input: Record<string, unknown>,
): NormalizedEditInput | undefined {
  if (typeof input.path !== "string") return undefined

  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    return {
      path: input.path,
      edits: [{ oldText: input.oldText, newText: input.newText }],
    }
  }

  if (!Array.isArray(input.edits)) return undefined

  const edits = input.edits.flatMap((item) => {
    const edit = asRecord(item)
    if (!edit) return []
    if (typeof edit.oldText !== "string") return []
    if (typeof edit.newText !== "string") return []
    return [{ oldText: edit.oldText, newText: edit.newText }]
  })

  if (edits.length === 0) return undefined
  return { path: input.path, edits }
}

interface StreamingUpdate {
  message: Record<string, unknown>
  createdAt: number
  timer: ReturnType<typeof setTimeout>
  scope: string
}

interface ReviewToolInput {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  details: unknown
  createdAt: number
  status: ReviewFileStatus
}

function addReviewFileFromToolInput({
  toolCallId,
  toolName,
  input,
  details,
  createdAt,
  status,
}: ReviewToolInput): void {
  if (toolName === "write") {
    const writeInput = parseWriteInput(input)
    if (!writeInput) return

    addReviewFile({
      id: toolCallId,
      kind: "write",
      path: writeInput.path,
      content: writeInput.content,
      changedLines: undefined,
      stats:
        status === "complete"
          ? { added: countLogicalLines(writeInput.content), removed: 0 }
          : undefined,
      status,
      createdAt,
    })
    return
  }

  if (toolName !== "edit") return

  const editInput = parseEditInput(input)
  if (!editInput) return

  addReviewFile({
    id: toolCallId,
    kind: "edit",
    path: editInput.path,
    content: buildEditPreview(editInput),
    changedLines:
      status === "complete"
        ? buildEditLineKinds(editInput, parseEditDetails(details))
        : undefined,
    stats: status === "complete" ? buildEditStats(editInput) : undefined,
    status,
    createdAt,
  })
}

function buildEditStats(input: NormalizedEditInput): {
  added: number
  removed: number
} {
  return input.edits.reduce(
    (stats, edit) => ({
      added: stats.added + countLogicalLines(edit.newText),
      removed: stats.removed + countLogicalLines(edit.oldText),
    }),
    { added: 0, removed: 0 },
  )
}

function buildEditPreview(input: NormalizedEditInput): string {
  return input.edits.map((edit) => edit.newText).join("\n")
}

function scheduleStreamingAssistantMessage(
  message: Record<string, unknown>,
  ctx: ExtensionContext,
): void {
  const scope = getReviewScope(ctx)
  const existing = streamingUpdatesByScope.get(scope)
  if (existing) clearTimeout(existing.timer)

  const update: StreamingUpdate = {
    message,
    createdAt: Date.now(),
    scope,
    timer: setTimeout(
      () => flushStreamingAssistantMessage(scope),
      STREAMING_UPDATE_DELAY_MS,
    ),
  }
  streamingUpdatesByScope.set(scope, update)
}

function flushStreamingAssistantMessage(scope: string): void {
  const update = streamingUpdatesByScope.get(scope)
  if (!update) return

  streamingUpdatesByScope.delete(scope)
  clearTimeout(update.timer)
  setReviewScope(update.scope)
  addReviewFilesFromAssistantMessage(
    update.message,
    update.createdAt,
    "streaming",
  )
}

function addReviewFilesFromAssistantMessage(
  message: Record<string, unknown>,
  createdAt: number,
  status: ReviewFileStatus,
): void {
  if (message.role !== "assistant") return
  const content = message.content
  if (!Array.isArray(content)) return

  batchReviewFileUpdates(() => {
    for (const contentItem of content) {
      const toolCall = parseToolCallContent(contentItem)
      if (!toolCall) continue

      addReviewFileFromToolInput({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.arguments,
        details: undefined,
        createdAt,
        status,
      })
    }
  })
}

async function rebuildReviewFiles(ctx: ExtensionContext): Promise<void> {
  activateReviewScope(ctx)
  const liveFiles = getReviewFiles()
  const reviewFiles: ReviewToolInput[] = []

  const toolCalls = new Map<string, ToolCallRecord>()
  for (const entry of getHistoryEntries(ctx)) {
    const message = getEntryMessage(entry)
    if (!message) continue

    collectToolCalls(message, toolCalls)
    collectToolResultReviewFile(message, toolCalls, entry, reviewFiles)
  }

  batchReviewFileUpdates(() => {
    clearReviewFiles()
    for (const reviewFile of reviewFiles) {
      addReviewFileFromToolInput(reviewFile)
    }
    preserveLiveFiles(liveFiles)
  })
}

function preserveLiveFiles(liveFiles: ReviewFile[]): void {
  const rebuiltIds = new Set(getReviewFiles().map((file) => file.id))
  for (const liveFile of liveFiles) {
    if (!rebuiltIds.has(liveFile.id)) addReviewFile(liveFile)
  }
}

interface ToolCallRecord {
  id: string
  name: string
  arguments: Record<string, unknown>
}

function getHistoryEntries(ctx: ExtensionContext): unknown[] {
  const entries = ctx.sessionManager.getEntries()
  if (entries.length > 0) return entries
  return ctx.sessionManager.getBranch()
}

function getEntryMessage(entry: unknown): Record<string, unknown> | undefined {
  const record = asRecord(entry)
  if (!record || record.type !== "message") return undefined
  return asRecord(record.message)
}

function collectToolCalls(
  message: Record<string, unknown>,
  toolCalls: Map<string, ToolCallRecord>,
): void {
  if (message.role !== "assistant") return
  if (!Array.isArray(message.content)) return

  for (const contentItem of message.content) {
    const toolCall = parseToolCallContent(contentItem)
    if (!toolCall) continue
    toolCalls.set(toolCall.id, toolCall)
  }
}

function collectToolResultReviewFile(
  message: Record<string, unknown>,
  toolCalls: Map<string, ToolCallRecord>,
  entry: unknown,
  reviewFiles: ReviewToolInput[],
): void {
  if (message.role !== "toolResult") return
  if (typeof message.toolCallId !== "string") return
  if (message.isError === true) return

  const toolCall = toolCalls.get(message.toolCallId)
  if (!toolCall) return

  reviewFiles.push({
    toolCallId: message.toolCallId,
    toolName: toolCall.name,
    input: toolCall.arguments,
    details: message.details,
    createdAt: getEntryTimestamp(entry),
    status: "complete",
  })
}

async function hydrateReviewFileForViewing(
  file: ReviewFile,
  cwd: string,
): Promise<ReviewFile> {
  if (file.kind !== "edit" || file.status !== "complete") return file

  const content = await readCurrentFile(file.path, cwd)
  return content === undefined ? file : { ...file, content }
}

async function readCurrentFile(
  path: string,
  cwd: string,
): Promise<string | undefined> {
  try {
    return await readFileWithLimit(resolvePath(path, cwd))
  } catch {
    return undefined
  }
}

function parseEditDetails(details: unknown): EditDetails | undefined {
  const record = asRecord(details)
  if (!record) return undefined

  return {
    diff: typeof record.diff === "string" ? record.diff : "",
    firstChangedLine:
      typeof record.firstChangedLine === "number"
        ? record.firstChangedLine
        : undefined,
  }
}

function parseToolCallContent(value: unknown): ToolCallRecord | undefined {
  const item = asRecord(value)
  if (!item || item.type !== "toolCall") return undefined
  if (typeof item.id !== "string") return undefined
  if (typeof item.name !== "string") return undefined

  const args = parseArguments(item.arguments)
  if (!args) return undefined

  return { id: item.id, name: item.name, arguments: args }
}

function getAssistantEventMessage(
  event: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(event)
  if (!record) return undefined
  return (
    asRecord(record.partial) ??
    asRecord(record.message) ??
    asRecord(record.error)
  )
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (record) return record

  if (typeof value !== "string") return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

function getEntryTimestamp(entry: unknown): number {
  const record = asRecord(entry)
  if (typeof record?.timestamp !== "string") return Date.now()
  const timestamp = Date.parse(record.timestamp)
  return Number.isNaN(timestamp) ? Date.now() : timestamp
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}

function activateReviewScope(ctx: ExtensionContext): void {
  setReviewScope(getReviewScope(ctx))
}

function getReviewScope(ctx: ExtensionContext): string {
  return `${ctx.sessionManager.getSessionId()}:${getCurrentCwd(ctx)}`
}

function getCurrentCwd(ctx: ExtensionContext): string {
  return ctx.sessionManager.getCwd() || ctx.cwd
}

async function readFileWithLimit(path: string): Promise<string> {
  const fileStat = await stat(path)
  if (fileStat.size > MAX_VIEW_FILE_BYTES) {
    throw new FileTooLargeError(fileStat.size)
  }
  return await readFile(path, "utf8")
}

class FileTooLargeError extends Error {
  constructor(readonly size: number) {
    super("File is too large to open")
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"]
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  const formatted =
    value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)
  return `${formatted} ${units[unitIndex]}`
}

async function selectReviewFile(
  ctx: ExtensionContext,
  files: ReviewFile[],
  cwd: string,
): Promise<ReviewFile | undefined> {
  return await ctx.ui.custom<ReviewFile | undefined>(
    (tui, theme, _kb, done) => {
      const component = new ReviewFileSelectComponent({
        files,
        cwd,
        theme,
        done,
        onRequestRender: () => tui.requestRender(),
      })
      return {
        render: (width: number) => component.render(width),
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data)
          tui.requestRender()
        },
        dispose: () => component.dispose(),
      }
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
      },
    },
  )
}

type PickerMode = "session" | "all"

type AllFilesState =
  | { status: "idle" }
  | { status: "searching"; requestId: number }
  | { status: "loaded"; files: string[] }
  | { status: "error"; message: string }

type PickerItem =
  | { type: "session"; file: ReviewFile }
  | { type: "all"; path: string }

interface ReviewFileSelectOptions {
  files: ReviewFile[]
  cwd: string
  theme: Theme
  done: (value: ReviewFile | undefined) => void
  onRequestRender: () => void
}

class ReviewFileSelectComponent {
  private static readonly maxVisible = 12
  private static readonly spinnerFrames = [
    "⠋",
    "⠙",
    "⠹",
    "⠸",
    "⠼",
    "⠴",
    "⠦",
    "⠧",
    "⠇",
    "⠏",
  ]

  private input = new Input()
  private mode: PickerMode = "session"
  private allFilesState: AllFilesState = { status: "idle" }
  private filtered: PickerItem[]
  private selectedIndex = 0
  private requestId = 0
  private spinnerIndex = 0
  private spinnerTimer: NodeJS.Timeout | undefined
  private openError: string | undefined

  constructor(private options: ReviewFileSelectOptions) {
    this.filtered = this.buildSessionItems(options.files)
    this.input.focused = true
    this.applyFilter()
  }

  invalidate(): void {}

  dispose(): void {
    this.stopSpinner()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width)
    const lines: string[] = [this.borderLine(innerWidth)]
    lines.push(truncateToWidth(this.renderModeHeader(), innerWidth, ""))

    if (this.mode === "all" && this.allFilesState.status === "searching") {
      lines.push(truncateToWidth(this.renderSearching(), innerWidth, ""))
    } else if (this.mode === "all" && this.allFilesState.status === "error") {
      lines.push(
        truncateToWidth(
          this.theme.fg("error", "Failed to search files"),
          innerWidth,
          "",
        ),
      )
    } else if (this.openError) {
      lines.push(
        truncateToWidth(this.theme.fg("error", this.openError), innerWidth, ""),
      )
    } else if (this.filtered.length === 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", this.emptyMessage()),
          innerWidth,
          "",
        ),
      )
    } else {
      this.renderItems(lines, innerWidth)
    }

    lines.push(this.borderLine(innerWidth))
    lines.push(...this.input.render(innerWidth))
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          "type to search · tab switch mode · ↑/↓ move · enter open · esc/ctrl-c cancel",
        ),
        innerWidth,
        "",
      ),
    )
    lines.push(this.borderLine(innerWidth))
    return lines
  }

  private renderModeHeader(): string {
    const session =
      this.mode === "session"
        ? this.theme.fg("accent", "Session")
        : this.theme.fg("dim", "Session")
    const all =
      this.mode === "all"
        ? this.theme.fg("accent", "All")
        : this.theme.fg("dim", "All")
    return `${session}${this.theme.fg("dim", " · ")}${all}`
  }

  private renderSearching(): string {
    const frame =
      ReviewFileSelectComponent.spinnerFrames[this.spinnerIndex] ?? "⠋"
    return `${this.theme.fg("accent", frame)} ${this.theme.fg("dim", "Searching")}`
  }

  private renderItems(lines: string[], innerWidth: number): void {
    const start = this.getVisibleStart()
    const end = Math.min(
      start + ReviewFileSelectComponent.maxVisible,
      this.filtered.length,
    )

    for (let index = start; index < end; index++) {
      const item = this.filtered[index]
      if (!item) continue
      const prefix = index === this.selectedIndex ? "→ " : "  "
      const option = `${prefix}${this.renderItem(item)}`
      lines.push(truncateToWidth(option, innerWidth, ""))
    }

    if (start > 0 || end < this.filtered.length) {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "dim",
            `(${this.selectedIndex + 1}/${this.filtered.length})`,
          ),
          innerWidth,
          "",
        ),
      )
    }
  }

  private renderItem(item: PickerItem): string {
    if (item.type === "all") return shortenPath(item.path)

    const file = item.file
    const action = this.theme.fg("accent", file.kind)
    return `${this.theme.fg("dim", formatTimestamp(file.createdAt))} ${shortenPath(file.path)} ${action} ${this.formatStats(file)}`
  }

  private emptyMessage(): string {
    if (this.mode === "session") return "No session files yet"
    return "No matching files"
  }

  private get theme(): Theme {
    return this.options.theme
  }

  private borderLine(width: number): string {
    return this.theme.fg("border", "─".repeat(width))
  }

  private formatStats(file: ReviewFile): string {
    const stats = file.stats
    if (!stats) return ""

    if (file.kind === "write") {
      return this.theme.fg("success", `+${stats.added}`)
    }

    return `${this.theme.fg("error", `-${stats.removed}`)}${this.theme.fg("success", `+${stats.added}`)}`
  }

  handleInput(data: string): void {
    if (isCtrlC(data) || matchesKey(data, "escape")) {
      this.options.done(undefined)
      return
    }

    if (matchesKey(data, "tab")) {
      this.switchMode()
      return
    }

    if (matchesKey(data, "enter")) {
      void this.openSelectedItem()
      return
    }

    if (matchesKey(data, "up")) {
      if (this.filtered.length > 0) this.moveSelection(-1)
      return
    }

    if (matchesKey(data, "down")) {
      if (this.filtered.length > 0) this.moveSelection(1)
      return
    }

    this.input.handleInput(data)
    this.openError = undefined
    this.applyFilter()
  }

  private switchMode(): void {
    this.mode = this.mode === "session" ? "all" : "session"
    this.selectedIndex = 0
    this.openError = undefined

    if (this.mode === "all") {
      this.ensureAllFilesLoaded()
    }

    this.applyFilter()
  }

  private ensureAllFilesLoaded(): void {
    if (
      this.allFilesState.status === "loaded" ||
      this.allFilesState.status === "searching"
    ) {
      return
    }

    const requestId = ++this.requestId
    this.allFilesState = { status: "searching", requestId }
    this.startSpinner()

    void loadAllFiles(this.options.cwd).then(
      (files) => {
        if (!this.isCurrentRequest(requestId)) return
        this.allFilesState = { status: "loaded", files }
        this.stopSpinner()
        this.applyFilter()
        this.options.onRequestRender()
      },
      () => {
        if (!this.isCurrentRequest(requestId)) return
        this.allFilesState = {
          status: "error",
          message: "Failed to search files",
        }
        this.stopSpinner()
        this.filtered = []
        this.selectedIndex = 0
        this.options.onRequestRender()
      },
    )
  }

  private isCurrentRequest(requestId: number): boolean {
    return (
      this.allFilesState.status === "searching" &&
      this.allFilesState.requestId === requestId
    )
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return
    this.spinnerTimer = setInterval(() => {
      if (this.allFilesState.status !== "searching") {
        this.stopSpinner()
        return
      }
      this.spinnerIndex =
        (this.spinnerIndex + 1) % ReviewFileSelectComponent.spinnerFrames.length
      this.options.onRequestRender()
    }, 90)
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = undefined
    this.spinnerIndex = 0
  }

  private async openSelectedItem(): Promise<void> {
    const item = this.filtered[this.selectedIndex]
    if (!item) return

    if (item.type === "session") {
      this.options.done(item.file)
      return
    }

    try {
      const content = await readFileWithLimit(
        resolvePath(item.path, this.options.cwd),
      )
      this.options.done({
        id: `file:${item.path}`,
        kind: "file",
        path: item.path,
        content,
        status: "complete",
        createdAt: Date.now(),
      })
    } catch (error) {
      this.openError =
        error instanceof FileTooLargeError
          ? `File is too large to open (${formatBytes(error.size)} > ${formatBytes(MAX_VIEW_FILE_BYTES)})`
          : "Failed to open file"
      this.options.onRequestRender()
    }
  }

  private getVisibleStart(): number {
    return Math.max(
      0,
      Math.min(
        this.selectedIndex -
          Math.floor(ReviewFileSelectComponent.maxVisible / 2),
        this.filtered.length - ReviewFileSelectComponent.maxVisible,
      ),
    )
  }

  private moveSelection(direction: 1 | -1): void {
    this.selectedIndex =
      (this.selectedIndex + direction + this.filtered.length) %
      this.filtered.length
  }

  private applyFilter(): void {
    const query = this.input.getValue()
    const items = this.getModeItems()
    this.filtered = fuzzyFilter(items, query, (item) => this.searchText(item))
    this.selectedIndex = 0
  }

  private getModeItems(): PickerItem[] {
    if (this.mode === "session")
      return this.buildSessionItems(this.options.files)
    if (this.allFilesState.status !== "loaded") return []
    return this.allFilesState.files.map((path) => ({ type: "all", path }))
  }

  private buildSessionItems(files: ReviewFile[]): PickerItem[] {
    return files.map((file) => ({ type: "session", file }))
  }

  private searchText(item: PickerItem): string {
    if (item.type === "all") return item.path
    const file = item.file
    return `${file.kind} ${file.path} ${formatTimestamp(file.createdAt)}`
  }
}

async function loadAllFiles(cwd: string): Promise<string[]> {
  const args = [
    "--files",
    "--hidden",
    "--no-ignore",
    "--color",
    "never",
    "-g",
    "!.git/",
  ]
  return await new Promise<string[]>((resolve, reject) => {
    execFile(
      "rg",
      args,
      { cwd, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }

        resolve(
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        )
      },
    )
  })
}

function isCtrlC(data: string): boolean {
  return matchesKey(data, "ctrl+c")
}

function shortenPath(path: string): string {
  const maxLength = 100
  if (path.length <= maxLength) return path
  return `…${path.slice(-(maxLength - 1))}`
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const month = padDatePart(date.getMonth() + 1)
  const day = padDatePart(date.getDate())
  const hours = padDatePart(date.getHours())
  const minutes = padDatePart(date.getMinutes())
  const seconds = padDatePart(date.getSeconds())
  return `${month}-${day} ${hours}:${minutes}:${seconds}`
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0")
}
