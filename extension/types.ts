export type ReviewLineKind = "added" | "changed" | "removed"

export interface ReviewFileStats {
  added: number
  removed: number
}

export type ReviewFileStatus = "streaming" | "complete"

export interface ReviewFile {
  id: string
  kind: "write" | "edit" | "file"
  path: string
  content: string
  changedLines?: Map<number, ReviewLineKind>
  stats?: ReviewFileStats
  status?: ReviewFileStatus
  createdAt: number
}

export interface ReviewComment {
  line: number
  endLine?: number
  text: string
}

export interface FileViewerResult {
  comments: ReviewComment[]
}

export type GitFileStatus = "M" | "A" | "D" | "R" | "??"

export interface GitChangedFile {
  id: string
  path: string
  oldPath?: string
  status: GitFileStatus
  added: number
  removed: number
  binary?: boolean
  large?: boolean
  size?: number
}

export interface GitDiffGuideEntry {
  path: string
  reason: string
  rank: number
}

export type DiffRowKind =
  | "hunk"
  | "context"
  | "added"
  | "removed"
  | "file"
  | "card"

export interface DiffRow {
  kind: DiffRowKind
  text: string
  changeKind?: "added" | "changed" | "removed"
  deletionMarker?: "before" | "after"
  oldLine?: number
  newLine?: number
  removed?: boolean
  commentKey?: string
  message?: string
}

export type GitDiffLoadStatus = "ok" | "binary" | "large" | "error"

export interface GitDiffLoadResult {
  status: GitDiffLoadStatus
  rows: DiffRow[]
}

export interface GitDiffComment {
  fileId: string
  path: string
  line?: number
  endLine?: number
  removed?: boolean
  location?: string
  lineContent?: string
  text: string
  order: number
}

export interface GitDiffViewerResult {
  comments: GitDiffComment[]
}
