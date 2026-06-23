import { execFile } from "node:child_process"
import { open, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { parseCommandArgs } from "./command-args.js"
import { countLogicalLines } from "./diff.js"
import type {
  DiffRow,
  GitChangedFile,
  GitDiffGuideEntry,
  GitDiffLoadResult,
} from "./types.js"

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
export const MAX_GIT_DIFF_INLINE_BYTES = 1024 * 1024

export type GitDiffScope = "all" | "staged" | "unstaged"

export interface GitDiffViewOptions {
  compareRef?: string
  scope: GitDiffScope
  guide?: boolean
  guideEntries?: GitDiffGuideEntry[]
}

export type GitRepoDiscovery =
  | { status: "ok"; root: string; base: string; baseLabel: string }
  | { status: "not-repo"; message: string }
  | { status: "error"; message: string }

export function parseGitDiffCompareRef(args: string): string | undefined {
  return parseGitDiffViewArgs(args).compareRef
}

type GitDiffArgFlag = "staged" | "unstaged" | "guide"

const GIT_DIFF_ARG_FLAGS = [
  { name: "staged", tokens: ["--staged", "-s"] },
  { name: "unstaged", tokens: ["--unstaged", "-u"] },
  { name: "guide", tokens: ["--guide", "-g"] },
] as const satisfies readonly {
  name: GitDiffArgFlag
  tokens: readonly string[]
}[]

export function parseGitDiffViewArgs(args: string): GitDiffViewOptions {
  const parsed = parseCommandArgs<GitDiffArgFlag>(args, GIT_DIFF_ARG_FLAGS)
  let scope: GitDiffScope = "all"

  for (const flag of parsed.flagOrder) {
    if (flag === "staged") scope = "staged"
    else if (flag === "unstaged") scope = "unstaged"
  }

  const options: GitDiffViewOptions = {
    compareRef: parsed.positionals.join(" ") || undefined,
    scope,
  }
  if (parsed.flags.has("guide")) options.guide = true
  return options
}

export async function discoverGitRepository(
  cwd: string,
  compareRef?: string,
  scope: GitDiffScope = "all",
): Promise<GitRepoDiscovery> {
  const rootResult = await gitMaybe(["rev-parse", "--show-toplevel"], cwd)
  if (rootResult.code !== 0) {
    return { status: "not-repo", message: "Not a Git repository" }
  }

  const root = rootResult.stdout.trim()
  if (compareRef && scope !== "unstaged") {
    const treeResult = await gitMaybe(
      ["rev-parse", "--verify", "--end-of-options", `${compareRef}^{tree}`],
      root,
    )
    if (treeResult.code !== 0) {
      return {
        status: "error",
        message: `Invalid git ref "${compareRef}"`,
      }
    }
    return {
      status: "ok",
      root,
      base: treeResult.stdout.trim(),
      baseLabel: compareRef,
    }
  }

  const headResult = await gitMaybe(["rev-parse", "--verify", "HEAD"], root)
  const base = headResult.code === 0 ? headResult.stdout.trim() : EMPTY_TREE
  const baseLabel =
    scope === "unstaged"
      ? "index"
      : headResult.code === 0
        ? "HEAD"
        : "empty tree"
  return { status: "ok", root, base, baseLabel }
}

export async function loadGitChangedFiles(
  root: string,
  base: string,
  scope: GitDiffScope = "all",
): Promise<GitChangedFile[]> {
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(nameStatusArgs(base, scope), root),
    git(numstatArgs(base, scope), root),
    scope === "staged"
      ? Promise.resolve("")
      : git(["ls-files", "--others", "--exclude-standard", "-z"], root),
  ])

  const files = parseNameStatus(nameStatus)
  applyNumstat(files, numstat)

  for (const path of splitNul(untracked)) {
    if (!path) continue
    const file = await buildUntrackedOverview(root, path)
    files.push(file)
  }

  return files
}

export async function loadGitFullDiff(
  root: string,
  base: string,
  scope: GitDiffScope,
  files: readonly GitChangedFile[],
): Promise<string> {
  const [trackedDiff, untrackedDiffs] = await Promise.all([
    git(fullDiffArgs(base, scope), root),
    Promise.all(
      files
        .filter((file) => file.status === "??")
        .map((file) => formatUntrackedDiff(root, file)),
    ),
  ])

  return [trackedDiff.trimEnd(), ...untrackedDiffs].filter(Boolean).join("\n")
}

export async function loadGitDiffRows(
  file: GitChangedFile,
  root: string,
  base: string,
  scope: GitDiffScope = "all",
): Promise<GitDiffLoadResult> {
  if (file.large) return largeResult(file)
  if (file.binary) return binaryResult(file)

  if (file.status === "??") {
    return await loadUntrackedDiffRows(file, root)
  }

  const pathspec = file.path
  const diff = await git(diffRowsArgs(base, scope, pathspec), root)
  if (isGitBinaryDiff(diff)) return binaryResult(file)
  const rows = parseUnifiedDiff(diff)
  return {
    status: "ok",
    rows: rows.length
      ? rows
      : cardRows(
          "No rendered diff",
          "Git did not return text hunks for this file.",
        ),
  }
}

export async function loadGitFileRows(
  file: GitChangedFile,
  root: string,
  base: string,
  scope: GitDiffScope = "all",
): Promise<GitDiffLoadResult> {
  if (file.large) return largeResult(file)
  if (file.binary) return binaryResult(file)

  try {
    const content =
      file.status === "D"
        ? await git(["show", `${base}:${file.oldPath ?? file.path}`], root)
        : scope === "staged"
          ? await git(["show", `:${file.path}`], root)
          : await readFileWithLimit(join(root, file.path))
    const rows = content.split("\n").map((text, index) => ({
      kind: "file" as const,
      text,
      newLine: index + 1,
      commentKey: `${file.path}:new:${index + 1}`,
    }))
    if (rows.length > 0 && rows[rows.length - 1]?.text === "") rows.pop()
    return {
      status: "ok",
      rows: rows.length
        ? rows
        : cardRows("Empty file", "This file has no content."),
    }
  } catch (error) {
    if (error instanceof FileTooLargeError)
      return {
        status: "large",
        rows: cardRows(
          "Large file",
          `This file is ${formatBytes(error.size)} and was not rendered inline.`,
        ),
      }
    return {
      status: "error",
      rows: cardRows(
        "Unable to load file",
        "The final file content could not be read.",
      ),
    }
  }
}

function nameStatusArgs(base: string, scope: GitDiffScope): string[] {
  if (scope === "unstaged") return ["diff", "--name-status", "-M", "--"]
  if (scope === "staged")
    return ["diff", "--cached", "--name-status", "-M", base, "--"]
  return ["diff", "--name-status", "-M", base, "--"]
}

function numstatArgs(base: string, scope: GitDiffScope): string[] {
  if (scope === "unstaged") return ["diff", "--numstat", "-M", "--"]
  if (scope === "staged")
    return ["diff", "--cached", "--numstat", "-M", base, "--"]
  return ["diff", "--numstat", "-M", base, "--"]
}

function fullDiffArgs(base: string, scope: GitDiffScope): string[] {
  if (scope === "unstaged")
    return ["diff", "--binary", "--unified=3", "-M", "--"]
  if (scope === "staged")
    return ["diff", "--cached", "--binary", "--unified=3", "-M", base, "--"]
  return ["diff", "--binary", "--unified=3", "-M", base, "--"]
}

function diffRowsArgs(
  base: string,
  scope: GitDiffScope,
  pathspec: string,
): string[] {
  if (scope === "unstaged")
    return ["diff", "--binary", "--unified=3", "-M", "--", pathspec]
  if (scope === "staged")
    return [
      "diff",
      "--cached",
      "--binary",
      "--unified=3",
      "-M",
      base,
      "--",
      pathspec,
    ]
  return ["diff", "--binary", "--unified=3", "-M", base, "--", pathspec]
}

export function parseNameStatus(output: string): GitChangedFile[] {
  const files: GitChangedFile[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    const parts = line.split("\t")
    const rawStatus = parts[0] ?? "M"
    const status = normalizeStatus(rawStatus)
    if (status === "R") {
      const oldPath = parts[1] ?? ""
      const path = parts[2] ?? oldPath
      files.push({
        id: `R:${oldPath}:${path}`,
        path,
        oldPath,
        status,
        added: 0,
        removed: 0,
      })
    } else {
      const path = parts[1] ?? ""
      files.push({
        id: `${status}:${path}`,
        path,
        status,
        added: 0,
        removed: 0,
      })
    }
  }
  return files
}

export function applyNumstat(files: GitChangedFile[], output: string): void {
  const byPath = new Map(files.map((file) => [file.path, file]))
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    const parts = line.split("\t")
    const addedText = parts[0] ?? "0"
    const removedText = parts[1] ?? "0"
    const path = parts.length >= 4 ? (parts[3] ?? "") : (parts[2] ?? "")
    const file = byPath.get(path)
    if (!file) continue
    file.binary = addedText === "-" || removedText === "-"
    file.added = Number.parseInt(addedText, 10) || 0
    file.removed = Number.parseInt(removedText, 10) || 0
  }
}

interface UnifiedDiffState {
  rows: DiffRow[]
  oldLine: number
  newLine: number
  inHunk: boolean
}

export function parseUnifiedDiff(diff: string): DiffRow[] {
  const state: UnifiedDiffState = {
    rows: [],
    oldLine: 0,
    newLine: 0,
    inHunk: false,
  }

  for (const line of diff.split("\n")) {
    parseUnifiedDiffLine(state, line)
  }

  return state.rows
}

function parseUnifiedDiffLine(state: UnifiedDiffState, line: string): void {
  const hunk = parseHunkHeader(line)
  if (hunk) {
    state.oldLine = hunk.oldLine
    state.newLine = hunk.newLine
    state.inHunk = true
    state.rows.push({ kind: "hunk", text: line })
    return
  }

  if (!state.inHunk || line.startsWith("\\ No newline")) return
  appendUnifiedDiffRow(state, line)
}

function parseHunkHeader(
  line: string,
): { oldLine: number; newLine: number } | undefined {
  if (!line.startsWith("@@")) return undefined
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
  if (!match) return undefined
  return { oldLine: Number(match[1]), newLine: Number(match[2]) }
}

function appendUnifiedDiffRow(state: UnifiedDiffState, line: string): void {
  if (line.startsWith("+")) appendAddedRow(state, line)
  else if (line.startsWith("-")) appendRemovedRow(state, line)
  else appendContextRow(state, line)
}

function appendAddedRow(state: UnifiedDiffState, line: string): void {
  state.rows.push({
    kind: "added",
    text: line.slice(1),
    newLine: state.newLine,
    commentKey: `${state.newLine}:new`,
  })
  state.newLine++
}

function appendRemovedRow(state: UnifiedDiffState, line: string): void {
  state.rows.push({
    kind: "removed",
    text: line.slice(1),
    oldLine: state.oldLine,
    removed: true,
    commentKey: `${state.oldLine}:old`,
  })
  state.oldLine++
}

function appendContextRow(state: UnifiedDiffState, line: string): void {
  state.rows.push({
    kind: "context",
    text: line.startsWith(" ") ? line.slice(1) : line,
    oldLine: state.oldLine,
    newLine: state.newLine,
    commentKey: `${state.newLine}:new`,
  })
  state.oldLine++
  state.newLine++
}

async function buildUntrackedOverview(
  root: string,
  path: string,
): Promise<GitChangedFile> {
  try {
    const fileStat = await stat(join(root, path))
    const binary = await isBinaryFile(join(root, path))
    const large = fileStat.size > MAX_GIT_DIFF_INLINE_BYTES
    const added =
      binary || large
        ? 0
        : countLogicalLines(await readFile(join(root, path), "utf8"))
    return {
      id: `??:${path}`,
      path,
      status: "??",
      added,
      removed: 0,
      binary,
      large,
      size: fileStat.size,
    }
  } catch {
    return { id: `??:${path}`, path, status: "??", added: 0, removed: 0 }
  }
}

async function loadUntrackedDiffRows(
  file: GitChangedFile,
  root: string,
): Promise<GitDiffLoadResult> {
  try {
    const content = await readFileWithLimit(join(root, file.path))
    const rows = content.split("\n").map((text, index) => ({
      kind: "added" as const,
      text,
      newLine: index + 1,
      commentKey: `${file.path}:new:${index + 1}`,
    }))
    if (rows.length > 0 && rows[rows.length - 1]?.text === "") rows.pop()
    return {
      status: "ok",
      rows: rows.length
        ? rows
        : cardRows(
            "Empty untracked file",
            "This empty file will be included by git add -A.",
          ),
    }
  } catch (error) {
    if (error instanceof FileTooLargeError) return largeResult(file)
    return {
      status: "error",
      rows: cardRows(
        "Unable to load file",
        "The untracked file could not be read.",
      ),
    }
  }
}

async function formatUntrackedDiff(
  root: string,
  file: GitChangedFile,
): Promise<string> {
  if (file.large) {
    throw new Error(
      `Cannot guide ${file.path}: untracked file is too large to include in the full diff.`,
    )
  }
  if (file.binary) {
    throw new Error(
      `Cannot guide ${file.path}: untracked binary files cannot be included in the full diff.`,
    )
  }

  const content = await readUntrackedDiffContent(root, file)
  const lines = splitFileLines(content)
  const header = [
    `diff --git a/${file.path} b/${file.path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${file.path}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ]
  return [...header, ...lines.map((line) => `+${line}`)].join("\n")
}

async function readUntrackedDiffContent(
  root: string,
  file: GitChangedFile,
): Promise<string> {
  try {
    return await readFileWithLimit(join(root, file.path))
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw new Error(
        `Cannot guide ${file.path}: untracked file is too large to include in the full diff.`,
      )
    }
    throw error
  }
}

function splitFileLines(content: string): string[] {
  if (!content) return []
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content
  return normalized ? normalized.split("\n") : []
}

function cardRows(title: string, message: string): DiffRow[] {
  return [{ kind: "card", text: title, message, commentKey: "file" }]
}

function largeResult(file: GitChangedFile): GitDiffLoadResult {
  return {
    status: "large",
    rows: cardRows(
      file.status === "??" ? "Large untracked file" : "Large file",
      `This file${file.size ? ` is ${formatBytes(file.size)}` : ""} was not rendered inline.`,
    ),
  }
}

function binaryResult(_file: GitChangedFile): GitDiffLoadResult {
  return {
    status: "binary",
    rows: cardRows("Binary file", "Binary content was not rendered inline."),
  }
}

function normalizeStatus(status: string): GitChangedFile["status"] {
  if (status.startsWith("R")) return "R"
  if (status.startsWith("A")) return "A"
  if (status.startsWith("D")) return "D"
  return "M"
}

function splitNul(text: string): string[] {
  return text.split("\0").filter(Boolean)
}

export function isGitBinaryDiff(diff: string): boolean {
  return (
    /^Binary files .+ differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)
  )
}

async function isBinaryFile(path: string): Promise<boolean> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(8000)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, result.bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

async function readFileWithLimit(path: string): Promise<string> {
  const fileStat = await stat(path)
  if (fileStat.size > MAX_GIT_DIFF_INLINE_BYTES)
    throw new FileTooLargeError(fileStat.size)
  return await readFile(path, "utf8")
}

class FileTooLargeError extends Error {
  constructor(readonly size: number) {
    super("File is too large")
  }
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || String(error)))
        else resolve(stdout)
      },
    )
  })
}

function gitMaybe(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            typeof (error as { code?: unknown } | null)?.code === "number"
              ? (error as { code: number }).code
              : 0,
          stdout,
          stderr,
        })
      },
    )
  })
}

export function formatBytes(bytes: number): string {
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
