import type { ReviewFile } from "./types.js"

const MAX_REVIEW_FILES = 50
const DEFAULT_SCOPE = "default"
const filesByScope = new Map<string, ReviewFile[]>()
const listenersByScope = new Map<string, Set<() => void>>()
let activeScope = DEFAULT_SCOPE

export function setReviewScope(scope: string): void {
  activeScope = scope || DEFAULT_SCOPE
}

export function addReviewFile(
  file: Omit<ReviewFile, "createdAt"> & { createdAt?: number },
): void {
  const files = getScopeFiles()
  const existingIndex = files.findIndex((item) => item.id === file.id)
  const existingFile = existingIndex >= 0 ? files[existingIndex] : undefined
  if (existingIndex >= 0) {
    files.splice(existingIndex, 1)
  }

  files.unshift({
    ...file,
    createdAt: existingFile?.createdAt ?? file.createdAt ?? Date.now(),
  })
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
  files.splice(0, files.length)
  notifyReviewFilesChanged()
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
  for (const listener of getScopeListeners()) listener()
}
