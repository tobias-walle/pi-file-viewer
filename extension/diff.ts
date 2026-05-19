import type { EditToolDetails } from "@mariozechner/pi-coding-agent"
import type { ReviewLineKind } from "./types.js"

export interface EditReplacement {
  oldText: string
  newText: string
}

export interface NormalizedEditInput {
  path: string
  edits: EditReplacement[]
}

export function buildEditLineKinds(
  input: NormalizedEditInput,
  details: EditToolDetails | undefined,
): Map<number, ReviewLineKind> | undefined {
  const fromDiff = buildLineKindsFromDiff(details?.diff)
  if (fromDiff?.size) return fromDiff

  const firstChangedLine = details?.firstChangedLine
  if (!firstChangedLine) return undefined

  const firstEdit = input.edits[0]
  if (!firstEdit) return undefined

  const oldLineCount = countLogicalLines(firstEdit.oldText)
  const newLineCount = countLogicalLines(firstEdit.newText)
  const lineKinds = new Map<number, ReviewLineKind>()

  if (newLineCount === 0) {
    lineKinds.set(firstChangedLine, "removed")
    return lineKinds
  }

  const changedCount = Math.min(oldLineCount, newLineCount)
  for (let offset = 0; offset < changedCount; offset++) {
    lineKinds.set(firstChangedLine + offset, "changed")
  }

  if (newLineCount > oldLineCount) {
    for (let offset = oldLineCount; offset < newLineCount; offset++) {
      lineKinds.set(firstChangedLine + offset, "added")
    }
  }

  if (oldLineCount > newLineCount) {
    const markerLine = firstChangedLine + Math.max(0, newLineCount - 1)
    lineKinds.set(markerLine, "removed")
  }

  return lineKinds
}

function buildLineKindsFromDiff(
  diff: string | undefined,
): Map<number, ReviewLineKind> | undefined {
  if (!diff) return undefined

  const lineKinds = new Map<number, ReviewLineKind>()
  for (const line of diff.split("\n")) {
    const match = /^([+-])\s*(\d+)\s/.exec(line)
    if (!match) continue

    const sign = match[1]
    const lineNumber = Number(match[2])
    if (!Number.isFinite(lineNumber)) continue

    const nextKind: ReviewLineKind = sign === "+" ? "added" : "removed"
    const currentKind = lineKinds.get(lineNumber)
    lineKinds.set(
      lineNumber,
      currentKind && currentKind !== nextKind ? "changed" : nextKind,
    )
  }

  return lineKinds.size > 0 ? lineKinds : undefined
}

export function countLogicalLines(text: string): number {
  if (text.length === 0) return 0

  let lineCount = 1
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lineCount++
  }

  return text.endsWith("\n") ? Math.max(1, lineCount - 1) : lineCount
}
