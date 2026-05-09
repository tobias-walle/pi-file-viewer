import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import type {
  EditToolDetails,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  WriteToolInput,
} from "@mariozechner/pi-coding-agent"
import {
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui"

import {
  buildEditLineKinds,
  countLogicalLines,
  type NormalizedEditInput,
} from "./diff.js"
import { resolvePath } from "./path.js"
import { addReviewFile, clearReviewFiles, getReviewFiles } from "./registry.js"
import type { ReviewFile, ReviewFileStatus } from "./types.js"
import { openFileViewer } from "./viewer.js"

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await rebuildReviewFiles(ctx)
  })

  pi.on("session_tree", async (_event, ctx) => {
    await rebuildReviewFiles(ctx)
  })

  pi.on("message_update", async (event, ctx) => {
    const message = getAssistantEventMessage(event.assistantMessageEvent)
    if (!message) return
    await addReviewFilesFromAssistantMessage(
      message,
      ctx.cwd,
      Date.now(),
      "streaming",
    )
  })

  pi.on("tool_call", async (event, ctx) => {
    await addReviewFileFromToolInput({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      details: undefined,
      cwd: ctx.cwd,
      createdAt: Date.now(),
      status: "streaming",
    })
  })

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return

    await addReviewFileFromToolInput({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      details: event.details,
      cwd: ctx.cwd,
      createdAt: Date.now(),
      status: "complete",
    })
  })

  pi.registerCommand("view-file", {
    description: "View a recent write/edit tool call in a reusable file viewer",
    handler: async (_args, ctx) => {
      await reviewFile(ctx)
    },
  })

  pi.registerShortcut("alt+w", {
    description: "Select write/edit tool call to view",
    handler: async (ctx) => {
      await reviewFile(ctx)
    },
  })
}

async function reviewFile(ctx: ExtensionContext): Promise<void> {
  await rebuildReviewFiles(ctx)
  const files = getReviewFiles()
  const cwd = ctx.sessionManager.getCwd() || ctx.cwd
  const file = await selectReviewFile(ctx, files, cwd)
  if (!file) return
  await openFileViewer(ctx, file)
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

function buildAllAddedLines(content: string): Map<number, "added"> {
  const lineCount = countLogicalLines(content)
  const lines = new Map<number, "added">()
  for (let line = 1; line <= lineCount; line++) {
    lines.set(line, "added")
  }
  return lines
}

interface ReviewToolInput {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  details: unknown
  cwd: string
  createdAt: number
  status: ReviewFileStatus
}

async function addReviewFileFromToolInput({
  toolCallId,
  toolName,
  input,
  details,
  cwd,
  createdAt,
  status,
}: ReviewToolInput): Promise<void> {
  if (toolName === "write") {
    const writeInput = parseWriteInput(input)
    if (!writeInput) return

    addReviewFile({
      id: toolCallId,
      kind: "write",
      path: writeInput.path,
      content: writeInput.content,
      changedLines: buildAllAddedLines(writeInput.content),
      stats: { added: countLogicalLines(writeInput.content), removed: 0 },
      status,
      createdAt,
    })
    return
  }

  if (toolName !== "edit") return

  const editInput = parseEditInput(input)
  if (!editInput) return

  const content =
    status === "complete"
      ? ((await readCurrentFile(editInput.path, cwd)) ??
        buildEditPreview(editInput))
      : buildEditPreview(editInput)

  addReviewFile({
    id: toolCallId,
    kind: "edit",
    path: editInput.path,
    content,
    changedLines: buildEditLineKinds(editInput, parseEditDetails(details)),
    stats: buildEditStats(editInput),
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

async function rebuildReviewFiles(ctx: ExtensionContext): Promise<void> {
  const liveFiles = getReviewFiles()
  const cwd = ctx.sessionManager.getCwd() || ctx.cwd
  clearReviewFiles()

  const toolCalls = new Map<string, ToolCallRecord>()
  for (const entry of getHistoryEntries(ctx)) {
    const message = getEntryMessage(entry)
    if (!message) continue

    collectToolCalls(message, toolCalls)
    await maybeAddToolResultReviewFile(message, toolCalls, cwd, entry)
  }

  preserveLiveFiles(liveFiles)
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

async function addReviewFilesFromAssistantMessage(
  message: Record<string, unknown>,
  cwd: string,
  createdAt: number,
  status: ReviewFileStatus,
): Promise<void> {
  if (message.role !== "assistant") return
  if (!Array.isArray(message.content)) return

  for (const contentItem of message.content) {
    const toolCall = parseToolCallContent(contentItem)
    if (!toolCall) continue

    await addReviewFileFromToolInput({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.arguments,
      details: undefined,
      cwd,
      createdAt,
      status,
    })
  }
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

async function maybeAddToolResultReviewFile(
  message: Record<string, unknown>,
  toolCalls: Map<string, ToolCallRecord>,
  cwd: string,
  entry: unknown,
): Promise<void> {
  if (message.role !== "toolResult") return
  if (typeof message.toolCallId !== "string") return
  if (message.isError === true) return

  const toolCall = toolCalls.get(message.toolCallId)
  if (!toolCall) return

  await addReviewFileFromToolInput({
    toolCallId: message.toolCallId,
    toolName: toolCall.name,
    input: toolCall.arguments,
    details: message.details,
    cwd,
    createdAt: getEntryTimestamp(entry),
    status: "complete",
  })
}

async function readCurrentFile(
  path: string,
  cwd: string,
): Promise<string | undefined> {
  try {
    return await readFile(resolvePath(path, cwd), "utf8")
  } catch {
    return undefined
  }
}

function parseEditDetails(details: unknown): EditToolDetails | undefined {
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
      const content = await readFile(
        resolvePath(item.path, this.options.cwd),
        "utf8",
      )
      this.options.done({
        id: `file:${item.path}`,
        kind: "file",
        path: item.path,
        content,
        status: "complete",
        createdAt: Date.now(),
      })
    } catch {
      this.openError = "Failed to open file"
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
