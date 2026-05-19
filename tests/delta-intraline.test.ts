import { expect, test } from "bun:test"
import { deltaIntralineRanges } from "../extension/delta-intraline.js"
import type { DiffRow } from "../extension/types.js"

type Section = ["noop" | "change", string]

function rows(minusLines: string[], plusLines: string[]): DiffRow[] {
  return [
    ...minusLines.map((text, index) => ({
      kind: "removed" as const,
      text,
      oldLine: index + 1,
    })),
    ...plusLines.map((text, index) => ({
      kind: "added" as const,
      text,
      newLine: index + 1,
    })),
  ]
}

function ranges(sections: Section[]): Array<{ start: number; end: number }> {
  const output: Array<{ start: number; end: number }> = []
  let offset = 0
  for (const [annotation, text] of sections) {
    const end = offset + text.length
    if (annotation === "change" && end > offset)
      output.push({ start: offset, end })
    offset = end
  }
  return output
}

function expectRanges(
  diffRows: DiffRow[],
  rowIndex: number,
  sections: Section[],
  maxLineDistance = 0.6,
): void {
  expect(
    deltaIntralineRanges(
      diffRows,
      diffRows[rowIndex] as DiffRow,
      rowIndex,
      maxLineDistance,
    ),
  ).toEqual(ranges(sections))
}

test("ports delta test_infer_edits_1", () => {
  const diffRows = rows(["aaa"], ["aba"])

  expectRanges(diffRows, 0, [["change", "aaa"]], 1)
  expectRanges(diffRows, 1, [["change", "aba"]], 1)
})

test("ports delta test_infer_edits_1_2", () => {
  const diffRows = rows(["aaa ccc"], ["aba ccc"])

  expectRanges(diffRows, 0, [
    ["noop", ""],
    ["change", "aaa"],
    ["noop", " ccc"],
  ])
  expectRanges(diffRows, 1, [
    ["noop", ""],
    ["change", "aba"],
    ["noop", " ccc"],
  ])
})

test("ports delta test_infer_edits_3", () => {
  const diffRows = rows(["d.iteritems()"], ["d.items()"])

  expectRanges(
    diffRows,
    0,
    [
      ["noop", "d."],
      ["change", "iteritems"],
      ["noop", "()"],
    ],
    1,
  )
  expectRanges(
    diffRows,
    1,
    [
      ["noop", "d."],
      ["change", "items"],
      ["noop", "()"],
    ],
    1,
  )
})

test("ports delta test_infer_edits_5 greedy line pairing", () => {
  const diffRows = rows(
    ["aaaa a aaa", "bbbb b bbb", "cccc c ccc"],
    ["bbbb ! bbb", "dddd d ddd", "cccc ! ccc"],
  )

  expectRanges(diffRows, 0, [["noop", "aaaa a aaa"]])
  expectRanges(diffRows, 1, [
    ["noop", "bbbb "],
    ["change", "b"],
    ["noop", " bbb"],
  ])
  expectRanges(diffRows, 2, [
    ["noop", "cccc "],
    ["change", "c"],
    ["noop", " ccc"],
  ])
  expectRanges(diffRows, 3, [
    ["noop", "bbbb"],
    ["noop", " "],
    ["change", "!"],
    ["noop", " bbb"],
  ])
  expectRanges(diffRows, 4, [["noop", "dddd d ddd"]])
  expectRanges(diffRows, 5, [
    ["noop", "cccc"],
    ["noop", " "],
    ["change", "!"],
    ["noop", " ccc"],
  ])
})

test("ports delta test_infer_edits_7 inserted lifetime", () => {
  const diffRows = rows(
    ["fn coalesce_edits<'a, EditOperation("],
    ["fn coalesce_edits<'a, 'b, EditOperation("],
  )

  expectRanges(diffRows, 0, [
    ["noop", "fn coalesce_edits<'a, "],
    ["noop", "EditOperation("],
  ])
  expectRanges(diffRows, 1, [
    ["noop", "fn coalesce_edits<'a,"],
    ["noop", " "],
    ["change", "'b, "],
    ["noop", "EditOperation("],
  ])
})

test("ports delta test_infer_edits_8 inserted function call", () => {
  const diffRows = rows(
    ['for _ in range(0, options["count"]):'],
    ['for _ in range(0, int(options["count"])):'],
  )

  expectRanges(diffRows, 0, [
    ["noop", "for _ in range(0, "],
    ["noop", 'options["count"])'],
    ["noop", ":"],
  ])
  expectRanges(diffRows, 1, [
    ["noop", "for _ in range(0,"],
    ["noop", " "],
    ["change", "int("],
    ["noop", 'options["count"])'],
    ["change", ")"],
    ["noop", ":"],
  ])
})

test("ports delta test_infer_edits_10 word replacement", () => {
  const diffRows = rows(
    ["so it is safe to read the commit number from any one of them."],
    ["so it is safe to read build info from any one of them."],
  )

  expectRanges(diffRows, 0, [
    ["noop", "so it is safe to read "],
    ["change", "the commit"],
    ["change", " "],
    ["change", "number"],
    ["noop", " from any one of them."],
  ])
  expectRanges(diffRows, 1, [
    ["noop", "so it is safe to read"],
    ["noop", " "],
    ["change", "build"],
    ["change", " "],
    ["change", "info"],
    ["noop", " from any one of them."],
  ])
})
