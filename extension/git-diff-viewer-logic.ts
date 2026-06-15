import { matchesKey } from "@mariozechner/pi-tui"
import type { DiffRow, GitChangedFile, GitDiffComment } from "./types.js"

type SearchDelta = -1 | 1

export type OverviewAction =
  | { type: "close" }
  | { type: "clearFilter" }
  | { type: "focusViewer" }
  | { type: "moveViewerPage"; delta: number }
  | { type: "startFilter" }
  | { type: "moveOverviewSearch"; delta: SearchDelta }
  | { type: "selectFile"; delta: number }
  | { type: "selectFileAbsolute"; index: number }
  | { type: "copyPath" }
  | { type: "none" }

interface OverviewActionOptions {
  hasFilter: boolean
  viewerHalf: number
  lastIndex: number
}

type ActionResolver<Options, Action> = {
  matches: (data: string) => boolean
  action: (options: Options) => Action
}

export function resolveOverviewAction(
  data: string,
  options: OverviewActionOptions,
): OverviewAction {
  return firstMatchingAction(data, options, overviewActionResolvers, {
    type: "none",
  })
}

const overviewActionResolvers: ActionResolver<
  OverviewActionOptions,
  OverviewAction
>[] = [
  { matches: (data) => data === "q", action: () => ({ type: "close" }) },
  {
    matches: (data) => matchesKey(data, "escape"),
    action: (options) =>
      options.hasFilter ? { type: "clearFilter" } : { type: "close" },
  },
  {
    matches: (data) => matchesKey(data, "enter"),
    action: () => ({ type: "focusViewer" }),
  },
  {
    matches: isPageDownKey,
    action: (options) => ({
      type: "moveViewerPage",
      delta: options.viewerHalf,
    }),
  },
  {
    matches: isPageUpKey,
    action: (options) => ({
      type: "moveViewerPage",
      delta: -options.viewerHalf,
    }),
  },
  { matches: (data) => data === "/", action: () => ({ type: "startFilter" }) },
  { matches: (data) => data === "y", action: () => ({ type: "copyPath" }) },
  {
    matches: (data) => data === "n",
    action: () => ({ type: "moveOverviewSearch", delta: 1 }),
  },
  {
    matches: (data) => data === "N",
    action: () => ({ type: "moveOverviewSearch", delta: -1 }),
  },
  { matches: isUpKey, action: () => ({ type: "selectFile", delta: -1 }) },
  { matches: isDownKey, action: () => ({ type: "selectFile", delta: 1 }) },

  {
    matches: (data) => data === "g",
    action: () => ({ type: "selectFileAbsolute", index: 0 }),
  },
  {
    matches: (data) => data === "G",
    action: (options) => ({
      type: "selectFileAbsolute",
      index: options.lastIndex,
    }),
  },
]

export type ViewerAction =
  | { type: "close" }
  | { type: "clearSearch" }
  | { type: "focusOverview" }
  | { type: "selectFile"; delta: number }
  | { type: "moveViewer"; delta: number }
  | { type: "moveViewerPage"; delta: number }
  | { type: "moveViewerAbsolute"; line: number }
  | { type: "startSearch" }
  | { type: "moveSearch"; delta: SearchDelta }
  | { type: "toggleViewMode" }
  | { type: "startComment" }
  | { type: "removeComment" }
  | { type: "clearComments" }
  | { type: "copyPath" }
  | { type: "none" }

interface ViewerActionOptions {
  hasSearch: boolean
  half: number
  lastLine: number
}

export function resolveViewerAction(
  data: string,
  options: ViewerActionOptions,
): ViewerAction {
  return firstMatchingAction(data, options, viewerActionResolvers, {
    type: "none",
  })
}

const viewerActionResolvers: ActionResolver<
  ViewerActionOptions,
  ViewerAction
>[] = [
  { matches: (data) => data === "q", action: () => ({ type: "close" }) },
  {
    matches: (data) => matchesKey(data, "escape"),
    action: (options) =>
      options.hasSearch ? { type: "clearSearch" } : { type: "focusOverview" },
  },
  {
    matches: (data) => matchesKey(data, "tab"),
    action: () => ({ type: "selectFile", delta: 1 }),
  },
  {
    matches: (data) => matchesKey(data, "shift+tab"),
    action: () => ({ type: "selectFile", delta: -1 }),
  },
  { matches: isUpKey, action: () => ({ type: "moveViewer", delta: -1 }) },
  { matches: isDownKey, action: () => ({ type: "moveViewer", delta: 1 }) },
  {
    matches: isPageUpKey,
    action: (options) => ({ type: "moveViewerPage", delta: -options.half }),
  },
  {
    matches: isPageDownKey,
    action: (options) => ({ type: "moveViewerPage", delta: options.half }),
  },
  {
    matches: (data) => data === "g",
    action: () => ({ type: "moveViewerAbsolute", line: 1 }),
  },
  {
    matches: (data) => data === "G",
    action: (options) => ({
      type: "moveViewerAbsolute",
      line: options.lastLine,
    }),
  },
  { matches: (data) => data === "/", action: () => ({ type: "startSearch" }) },
  {
    matches: (data) => data === "n",
    action: () => ({ type: "moveSearch", delta: 1 }),
  },
  {
    matches: (data) => data === "N",
    action: () => ({ type: "moveSearch", delta: -1 }),
  },
  {
    matches: (data) => data === "v",
    action: () => ({ type: "toggleViewMode" }),
  },
  { matches: (data) => data === "y", action: () => ({ type: "copyPath" }) },
  { matches: isCommentKey, action: () => ({ type: "startComment" }) },
  {
    matches: (data) => data === "x",
    action: () => ({ type: "removeComment" }),
  },
  {
    matches: (data) => data === "C",
    action: () => ({ type: "clearComments" }),
  },
]

function firstMatchingAction<Options, Action>(
  data: string,
  options: Options,
  resolvers: ActionResolver<Options, Action>[],
  fallback: Action,
): Action {
  return (
    resolvers.find((resolver) => resolver.matches(data))?.action(options) ??
    fallback
  )
}

function isUpKey(data: string): boolean {
  return matchesKey(data, "up") || data === "k"
}

function isDownKey(data: string): boolean {
  return matchesKey(data, "down") || data === "j"
}

function isPageUpKey(data: string): boolean {
  return data === "u" || matchesKey(data, "ctrl+u")
}

function isPageDownKey(data: string): boolean {
  return data === "d" || matchesKey(data, "ctrl+d")
}

function isCommentKey(data: string): boolean {
  return data === "c" || matchesKey(data, "enter")
}

export function diffRowMarkerKind(
  row: DiffRow,
  hasComment: boolean,
): "comment" | "added" | "removed" | "hunk" | "plain" {
  if (hasComment) return "comment"
  if (row.kind === "added") return "added"
  if (row.kind === "removed") return "removed"
  if (row.kind === "hunk") return "hunk"
  return "plain"
}

export function diffRowLineNumbers(
  row: DiffRow,
  numberWidth: number,
): { oldText: string; newText: string } {
  const empty = " ".repeat(numberWidth)
  return {
    oldText: row.oldLine ? String(row.oldLine).padStart(numberWidth) : empty,
    newText: row.newLine ? String(row.newLine).padStart(numberWidth) : empty,
  }
}

export function buildGitDiffComments(
  files: GitChangedFile[],
  comments: ReadonlyMap<string, string>,
  lineContent = new Map<string, string>(),
): GitDiffComment[] {
  return files.flatMap((file) => commentsForFile(file, comments, lineContent))
}

function commentsForFile(
  file: GitChangedFile,
  comments: ReadonlyMap<string, string>,
  lineContent: ReadonlyMap<string, string>,
): GitDiffComment[] {
  const output: GitDiffComment[] = []
  for (const [key, text] of comments) {
    const parsed = parseCommentKey(file, key)
    if (!parsed) continue
    output.push({
      fileId: file.id,
      path: file.path,
      lineContent: lineContent.get(key),
      text,
      ...parsed,
    })
  }
  return output
}

function parseCommentKey(
  file: GitChangedFile,
  key: string,
): Pick<GitDiffComment, "line" | "removed" | "order"> | undefined {
  if (!key.startsWith(`${file.id}\t`)) return undefined
  const [, kind, rawLine] = key.split("\t")
  const parsedLine = kind === "file" ? undefined : Number(rawLine)
  const line = Number.isFinite(parsedLine) ? parsedLine : undefined
  return {
    line,
    removed: kind === "old",
    order: kind === "file" ? Number.MAX_SAFE_INTEGER : (line ?? 0),
  }
}
