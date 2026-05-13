import { expect, test } from "bun:test"
import {
  decorateSearchMatches,
  findNextSearchMatchIndex,
  lineHasSearchMatch,
  stripAnsi,
} from "../extension/search.js"

const theme = {
  getColorMode: () => "truecolor",
} as never

test("search strips ansi and finds matches case-insensitively", () => {
  expect(stripAnsi("\u001b[31mHello\u001b[39m")).toBe("Hello")
  expect(lineHasSearchMatch("\u001b[31mHello\u001b[39m", "hello")).toBe(true)
})

test("search navigation wraps and can include current line", () => {
  const lines = ["first", "target one", "middle", "target two"]

  expect(findNextSearchMatchIndex(lines, "target", 0, 1)).toBe(1)
  expect(findNextSearchMatchIndex(lines, "target", 1, 1)).toBe(3)
  expect(findNextSearchMatchIndex(lines, "target", 1, -1)).toBe(3)
  expect(findNextSearchMatchIndex(lines, "target", 1, 1, true)).toBe(1)
})

test("search decoration highlights only matching ranges", () => {
  const output = decorateSearchMatches(
    "one two one",
    "one",
    theme,
    "\u001b[49m",
  )

  expect(output).toContain("\u001b[48;2;90;74;0mone\u001b[49m")
  expect(output.endsWith("one\u001b[49m")).toBe(true)
})
