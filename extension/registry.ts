import type { ReviewFile } from "./types.js"

const MAX_REVIEW_FILES = 50
const files: ReviewFile[] = []
const listeners = new Set<() => void>()

export function addReviewFile(
  file: Omit<ReviewFile, "createdAt"> & { createdAt?: number },
): void {
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
  return [...files].sort((a, b) => b.createdAt - a.createdAt)
}

export function getReviewFile(id: string): ReviewFile | undefined {
  return files.find((file) => file.id === id)
}

export function subscribeReviewFiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearReviewFiles(): void {
  files.splice(0, files.length)
  notifyReviewFilesChanged()
}

function notifyReviewFilesChanged(): void {
  for (const listener of listeners) listener()
}
