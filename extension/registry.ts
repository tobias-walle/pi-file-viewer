import type { ReviewFile } from "./types.js"

const MAX_REVIEW_FILES = 50
const DEFAULT_SCOPE = "default"
const filesByScope = new Map<string, ReviewFile[]>()
const listenersByScope = new Map<string, Set<() => void>>()
let activeScope = DEFAULT_SCOPE
let batchDepth = 0
const pendingNotifyScopes = new Set<string>()

export function setReviewScope(scope: string): void {
  activeScope = scope || DEFAULT_SCOPE
}

export function addReviewFile(
  file: Omit<ReviewFile, "createdAt"> & { createdAt?: number },
): void {
  const files = getScopeFiles()
  const existingIndex = files.findIndex((item) => item.id === file.id)
  const existingFile = existingIndex >= 0 ? files[existingIndex] : undefined
  const nextFile = {
    ...file,
    createdAt: existingFile?.createdAt ?? file.createdAt ?? Date.now(),
  }

  if (existingFile && isSameReviewFile(existingFile, nextFile)) return

  if (existingIndex >= 0) {
    files.splice(existingIndex, 1)
  }

  files.unshift(nextFile)
  files.splice(MAX_REVIEW_FILES)
  notifyReviewFilesChanged()
}

export function getReviewFiles(): ReviewFile[] {
  return [...getScopeFiles()].sort((a, b) => b.createdAt - a.createdAt)
}

export function getReviewFile(id: string): ReviewFile | undefined {
  return getScopeFiles().find((file) => file.id === id)
}

export function subscribeReviewFiles(listener: () => void): () => void {
  const listeners = getScopeListeners()
  const scope = activeScope
  listeners.add(listener)
  return () => listenersByScope.get(scope)?.delete(listener)
}

export function clearReviewFiles(): void {
  const files = getScopeFiles()
  if (files.length === 0) return
  files.splice(0, files.length)
  notifyReviewFilesChanged()
}

export function batchReviewFileUpdates(callback: () => void): void {
  batchDepth++
  try {
    callback()
  } finally {
    batchDepth--
    if (batchDepth === 0) flushPendingNotifications()
  }
}

function getScopeFiles(): ReviewFile[] {
  const files = filesByScope.get(activeScope)
  if (files) return files

  const nextFiles: ReviewFile[] = []
  filesByScope.set(activeScope, nextFiles)
  return nextFiles
}

function getScopeListeners(): Set<() => void> {
  const listeners = listenersByScope.get(activeScope)
  if (listeners) return listeners

  const nextListeners = new Set<() => void>()
  listenersByScope.set(activeScope, nextListeners)
  return nextListeners
}

function notifyReviewFilesChanged(): void {
  if (batchDepth > 0) {
    pendingNotifyScopes.add(activeScope)
    return
  }

  notifyScope(activeScope)
}

function flushPendingNotifications(): void {
  const scopes = [...pendingNotifyScopes]
  pendingNotifyScopes.clear()
  for (const scope of scopes) notifyScope(scope)
}

function notifyScope(scope: string): void {
  const listeners = listenersByScope.get(scope)
  if (!listeners) return
  for (const listener of listeners) listener()
}

function isSameReviewFile(a: ReviewFile, b: ReviewFile): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.path === b.path &&
    a.content === b.content &&
    a.status === b.status &&
    a.createdAt === b.createdAt &&
    sameStats(a.stats, b.stats) &&
    sameLineKinds(a.changedLines, b.changedLines)
  )
}

function sameStats(a: ReviewFile["stats"], b: ReviewFile["stats"]): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.added === b.added && a.removed === b.removed
}

function sameLineKinds(
  a: ReviewFile["changedLines"],
  b: ReviewFile["changedLines"],
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.size !== b.size) return false

  for (const [line, kind] of a) {
    if (b.get(line) !== kind) return false
  }
  return true
}
