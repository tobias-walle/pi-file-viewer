import type { DiffRow } from "./types.js"

// This file is a TypeScript port of delta's intraline diff algorithm.
// Sources:
// - https://github.com/dandavison/delta/blob/main/src/edits.rs
// - https://github.com/dandavison/delta/blob/main/src/align.rs
//
// At a high level delta does three things:
// 1. Split a changed hunk into removed and added lines.
// 2. Greedily pair removed lines with similar added lines.
// 3. For each pair, align word and punctuation tokens with a weighted edit-distance table.
//    Tokens that are deleted or inserted become the stronger intraline highlight ranges.

const DELETION_COST = 2
const INSERTION_COST = 2
const INITIAL_MISMATCH_PENALTY = 1
const DEFAULT_MAX_LINE_DISTANCE = 0.6

type Operation = "noop" | "deletion" | "insertion"
type Annotation = "noop" | "change"

interface Cell {
  parent: number
  operation: Operation
  cost: number
}

interface AnnotatedSection {
  annotation: Annotation
  text: string
}

interface AlignmentResult {
  x: string[]
  y: string[]
  table: Cell[]
  dim: [number, number]
}

export interface IntralineRange {
  start: number
  end: number
}

export interface DeltaIntralineRangeCacheOptions {
  maxLineDistance?: number
  maxBlockRows?: number
  maxLineLength?: number
}

const DEFAULT_MAX_BLOCK_ROWS = 120
const DEFAULT_MAX_LINE_LENGTH = 2000

export function deltaIntralineRanges(
  rows: DiffRow[],
  row: DiffRow,
  rowIndex: number,
  maxLineDistance = DEFAULT_MAX_LINE_DISTANCE,
): IntralineRange[] {
  if (row.kind !== "added" && row.kind !== "removed") return []
  return (
    buildDeltaIntralineRangeCache(rows, { maxLineDistance })[rowIndex] ?? []
  )
}

export function buildDeltaIntralineRangeCache(
  rows: DiffRow[],
  options: DeltaIntralineRangeCacheOptions = {},
): IntralineRange[][] {
  const rangesByIndex = rows.map(() => [] as IntralineRange[])
  const maxLineDistance = options.maxLineDistance ?? DEFAULT_MAX_LINE_DISTANCE
  const maxBlockRows = options.maxBlockRows ?? DEFAULT_MAX_BLOCK_ROWS
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH

  let index = 0
  while (index < rows.length) {
    if (!isChangedRow(rows[index])) {
      index++
      continue
    }

    const start = index
    while (index < rows.length && isChangedRow(rows[index])) index++
    const blockRows = rows.slice(start, index)
    if (
      blockRows.length > maxBlockRows ||
      blockRows.some((blockRow) => blockRow.text.length > maxLineLength)
    ) {
      continue
    }

    fillBlockRanges(
      rangesByIndex,
      blockRows.map((blockRow, blockIndex) => ({
        row: blockRow,
        index: start + blockIndex,
      })),
      maxLineDistance,
    )
  }

  return rangesByIndex
}

function fillBlockRanges(
  rangesByIndex: IntralineRange[][],
  blockRows: Array<{ row: DiffRow; index: number }>,
  maxLineDistance: number,
): void {
  // Delta reasons about contiguous change blocks, not isolated adjacent pairs.
  // Example: two removed lines followed by two added lines are matched as a small batch.
  const minusRows = blockRows.filter(({ row }) => row.kind === "removed")
  const plusRows = blockRows.filter(({ row }) => row.kind === "added")
  if (minusRows.length === 0 || plusRows.length === 0) return

  const result = inferEdits(
    minusRows.map(({ row }) => row.text),
    plusRows.map(({ row }) => row.text),
    maxLineDistance,
  )

  for (const [lineIndex, { index }] of minusRows.entries()) {
    rangesByIndex[index] = annotationsToRanges(
      result.annotatedMinusLines[lineIndex] ?? [],
    )
  }
  for (const [lineIndex, { index }] of plusRows.entries()) {
    rangesByIndex[index] = annotationsToRanges(
      result.annotatedPlusLines[lineIndex] ?? [],
    )
  }
}

function isChangedRow(row: DiffRow | undefined): boolean {
  return row?.kind === "added" || row?.kind === "removed"
}

function inferEdits(
  minusLines: string[],
  plusLines: string[],
  maxLineDistance: number,
): {
  annotatedMinusLines: AnnotatedSection[][]
  annotatedPlusLines: AnnotatedSection[][]
} {
  const annotatedMinusLines: AnnotatedSection[][] = []
  const annotatedPlusLines: AnnotatedSection[][] = []
  let plusIndex = 0

  // Greedy line pairing from delta:
  // For each removed line, scan forward through the remaining added lines until a close enough
  // match is found. Added lines skipped during this scan are emitted as unpaired.
  minusLinesLoop: for (const minusLine of minusLines) {
    let considered = 0
    for (const plusLine of plusLines.slice(plusIndex)) {
      const alignment = makeAlignment(tokenize(minusLine), tokenize(plusLine))
      const annotated = annotate(alignment, minusLine, plusLine)
      // Distance is the fraction of visible changed content over total visible content.
      // Delta's default max-line-distance is 0.6, so unrelated lines are not paired.
      if (annotated.distance <= maxLineDistance) {
        for (const rejectedPlusLine of plusLines.slice(
          plusIndex,
          plusIndex + considered,
        )) {
          annotatedPlusLines.push([
            { annotation: "noop", text: rejectedPlusLine },
          ])
          plusIndex++
        }
        annotatedMinusLines.push(annotated.minusLine)
        annotatedPlusLines.push(annotated.plusLine)
        plusIndex++
        continue minusLinesLoop
      }
      considered++
    }

    annotatedMinusLines.push([{ annotation: "noop", text: minusLine }])
  }

  for (const plusLine of plusLines.slice(plusIndex)) {
    annotatedPlusLines.push([{ annotation: "noop", text: plusLine }])
  }

  return { annotatedMinusLines, annotatedPlusLines }
}

function tokenize(line: string): string[] {
  // Match delta's default tokenization regex: words are full tokens, everything between words
  // is split into individual characters. This keeps identifiers stable while still finding
  // small punctuation edits like added commas, quotes, or braces.
  // The initial empty token mirrors delta's historical prefix handling and keeps alignment
  // behavior compatible with its Rust implementation.
  const tokens = [""]
  const regex = /\w+/g
  let offset = 0

  for (const match of line.matchAll(regex)) {
    const matchText = match[0]
    const matchStart = match.index ?? 0
    if (offset === 0 && matchStart > 0) tokens.push("")
    tokens.push(...graphemes(line.slice(offset, matchStart)))
    tokens.push(matchText)
    offset = matchStart + matchText.length
  }

  if (offset < line.length) {
    if (offset === 0) tokens.push("")
    tokens.push(...graphemes(line.slice(offset)))
  }

  return tokens
}

function graphemes(text: string): string[] {
  return Array.from(text)
}

function makeAlignment(x: string[], y: string[]): AlignmentResult {
  const dim: [number, number] = [y.length + 1, x.length + 1]
  const table: Cell[] = Array.from({ length: dim[0] * dim[1] }, () => ({
    parent: 0,
    operation: "noop",
    cost: 0,
  }))
  const alignment = { x, y, table, dim }
  fillAlignment(alignment)
  return alignment
}

function fillAlignment(alignment: AlignmentResult): void {
  for (let i = 1; i < alignment.dim[1]; i++) {
    alignment.table[i] = {
      parent: 0,
      operation: "deletion",
      cost: i * DELETION_COST + INITIAL_MISMATCH_PENALTY,
    }
  }

  for (let j = 1; j < alignment.dim[0]; j++) {
    alignment.table[j * alignment.dim[1]] = {
      parent: 0,
      operation: "insertion",
      cost: j * INSERTION_COST + INITIAL_MISMATCH_PENALTY,
    }
  }

  // Fill a Needleman-Wunsch / Wagner-Fischer dynamic-programming table.
  // x tokens are columns, y tokens are rows. Each cell stores the cheapest previous cell
  // and which operation was used to get here.
  for (const [i, xToken] of alignment.x.entries()) {
    for (const [j, yToken] of alignment.y.entries()) {
      const left = alignmentIndex(alignment, i, j + 1)
      const diag = alignmentIndex(alignment, i, j)
      const up = alignmentIndex(alignment, i + 1, j)
      // Candidate order matters on ties. Delta considers insertion, then deletion, then noop.
      // That groups changed tokens together and treats moved text as delete plus insert.
      const candidates: Cell[] = [
        {
          parent: up,
          operation: "insertion",
          cost: mismatchCost(alignment, up, INSERTION_COST),
        },
        {
          parent: left,
          operation: "deletion",
          cost: mismatchCost(alignment, left, DELETION_COST),
        },
        {
          parent: diag,
          operation: "noop",
          cost:
            xToken === yToken ? (alignment.table[diag]?.cost ?? 0) : Infinity,
        },
      ]
      alignment.table[alignmentIndex(alignment, i + 1, j + 1)] = candidates
        .slice(1)
        .reduce(
          (best, candidate) => (candidate.cost < best.cost ? candidate : best),
          candidates[0] as Cell,
        )
    }
  }
}

function mismatchCost(
  alignment: AlignmentResult,
  parent: number,
  basicCost: number,
): number {
  const parentCell = alignment.table[parent]
  // Starting a new changed run is slightly more expensive than extending one.
  // This biases the alignment toward fewer, larger highlighted spans instead of scattered edits.
  return (
    (parentCell?.cost ?? 0) +
    basicCost +
    (parentCell?.operation === "noop" ? INITIAL_MISMATCH_PENALTY : 0)
  )
}

function alignmentOperations(alignment: AlignmentResult): Operation[] {
  // Walk parent pointers backwards from the bottom-right cell to recover the edit script.
  const ops: Operation[] = []
  let cell =
    alignment.table[
      alignmentIndex(alignment, alignment.x.length, alignment.y.length)
    ]
  while (cell) {
    ops.unshift(cell.operation)
    if (cell.parent === 0) break
    cell = alignment.table[cell.parent]
  }
  return ops
}

function coalescedOperations(
  alignment: AlignmentResult,
): Array<[Operation, number]> {
  // Delta coalesces adjacent identical operations before converting token operations back into
  // source substrings. This is what makes one contiguous highlight instead of one per token.
  return runLengthEncode(alignmentOperations(alignment))
}

function runLengthEncode<T>(sequence: T[]): Array<[T, number]> {
  const encoded: Array<[T, number]> = []
  if (sequence.length === 0) return encoded

  let current = sequence[0] as T
  let count = 1
  for (const item of sequence.slice(1)) {
    if (item === current) count++
    else {
      encoded.push([current, count])
      current = item
      count = 1
    }
  }
  encoded.push([current, count])
  return encoded
}

function alignmentIndex(
  alignment: AlignmentResult,
  i: number,
  j: number,
): number {
  return j * alignment.dim[1] + i
}

// Convert token-level operations into source-string sections and compute the line distance.
// This is ported from delta's edits.rs annotate function.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keeping the port close to delta makes it easier to compare and update.
function annotate(
  alignment: AlignmentResult,
  minusLine: string,
  plusLine: string,
): {
  minusLine: AnnotatedSection[]
  plusLine: AnnotatedSection[]
  distance: number
} {
  const annotatedMinusLine: AnnotatedSection[] = []
  const annotatedPlusLine: AnnotatedSection[] = []
  let xOffset = 0
  let yOffset = 0
  let minusLineOffset = 0
  let plusLineOffset = 0
  let distanceNumerator = 0
  let distanceDenominator = 0
  let minusPrevious: Annotation = "noop"
  let plusPrevious: Annotation = "noop"

  for (const [operation, count] of coalescedOperations(alignment)) {
    if (operation === "deletion") {
      const section = sectionFromTokens(
        alignment.x,
        count,
        xOffset,
        minusLineOffset,
        minusLine,
      )
      xOffset += count
      minusLineOffset += section.length
      // Deleted tokens are highlighted on the removed line and count as changed distance.
      const contribution = distanceContribution(section)
      distanceNumerator += contribution
      distanceDenominator += contribution
      annotatedMinusLine.push({ annotation: "change", text: section })
      minusPrevious = "change"
    } else if (operation === "insertion") {
      const section = sectionFromTokens(
        alignment.y,
        count,
        yOffset,
        plusLineOffset,
        plusLine,
      )
      yOffset += count
      plusLineOffset += section.length
      // Inserted tokens are highlighted on the added line and count as changed distance.
      const contribution = distanceContribution(section)
      distanceNumerator += contribution
      distanceDenominator += contribution
      annotatedPlusLine.push({ annotation: "change", text: section })
      plusPrevious = "change"
    } else {
      const minusSection = sectionFromTokens(
        alignment.x,
        count,
        xOffset,
        minusLineOffset,
        minusLine,
      )
      xOffset += count
      minusLineOffset += minusSection.length
      // Matching tokens contribute to the denominator twice because they exist on both lines.
      const contribution = distanceContribution(minusSection)
      distanceDenominator += 2 * contribution
      const isSpace = minusSection.trim().length === 0
      // Delta intentionally absorbs some whitespace into surrounding changed spans.
      // This makes highlights look natural for edits like adding an argument plus its comma/space.
      const coalesceSpaceWithPrevious =
        isSpace &&
        ((minusPrevious === "change" &&
          plusPrevious === "change" &&
          (xOffset < alignment.x.length - 1 ||
            yOffset < alignment.y.length - 1)) ||
          (minusPrevious === "noop" && plusPrevious === "noop"))
      const noopAnnotation = coalesceSpaceWithPrevious ? minusPrevious : "noop"
      annotatedMinusLine.push({
        annotation: noopAnnotation,
        text: minusSection,
      })

      const plusSection = sectionFromTokens(
        alignment.y,
        count,
        yOffset,
        plusLineOffset,
        plusLine,
      )
      yOffset += count
      plusLineOffset += plusSection.length
      annotatedPlusLine.push({
        annotation: coalesceSpaceWithPrevious ? plusPrevious : "noop",
        text: plusSection,
      })
      minusPrevious = "noop"
      plusPrevious = "noop"
    }
  }

  return {
    minusLine: annotatedMinusLine,
    plusLine: annotatedPlusLine,
    distance:
      distanceDenominator > 0 ? distanceNumerator / distanceDenominator : 0,
  }
}

function sectionFromTokens(
  tokens: string[],
  count: number,
  tokenOffset: number,
  lineOffset: number,
  line: string,
): string {
  // Operations are over tokens, but rendering needs character offsets in the original line.
  // Sum the token lengths to recover the exact source slice.
  const length = tokens
    .slice(tokenOffset, tokenOffset + count)
    .reduce((sum, token) => sum + token.length, 0)
  return line.slice(lineOffset, lineOffset + length)
}

function distanceContribution(section: string): number {
  return section.trim().length
}

function annotationsToRanges(sections: AnnotatedSection[]): IntralineRange[] {
  const ranges: IntralineRange[] = []
  let offset = 0
  for (const section of sections) {
    const nextOffset = offset + section.text.length
    if (section.annotation === "change" && nextOffset > offset) {
      ranges.push({ start: offset, end: nextOffset })
    }
    offset = nextOffset
  }
  return ranges
}
