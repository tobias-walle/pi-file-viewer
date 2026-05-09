import { expect, test } from "bun:test"
import { buildEditLineKinds, countLogicalLines } from "../extension/diff.js"

test("counts logical lines without counting a trailing newline", () => {
  expect(countLogicalLines("")).toBe(0)
  expect(countLogicalLines("one")).toBe(1)
  expect(countLogicalLines("one\n")).toBe(1)
  expect(countLogicalLines("one\ntwo")).toBe(2)
})

test("builds changed and added line kinds from edit details", () => {
  const lineKinds = buildEditLineKinds(
    {
      path: "example.ts",
      edits: [{ oldText: "old", newText: "new\nadded" }],
    },
    { diff: "", firstChangedLine: 10 },
  )

  expect(lineKinds?.get(10)).toBe("changed")
  expect(lineKinds?.get(11)).toBe("added")
})

test("prefers diff details when available", () => {
  const lineKinds = buildEditLineKinds(
    {
      path: "example.ts",
      edits: [{ oldText: "old", newText: "new" }],
    },
    { diff: "- 4 old\n+ 4 new", firstChangedLine: 1 },
  )

  expect(lineKinds?.get(4)).toBe("changed")
  expect(lineKinds?.has(1)).toBe(false)
})
