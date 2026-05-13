import { expect, test } from "bun:test"
import { LineBuffer } from "../extension/ui/line-buffer.js"

function buffer(lines: string[]): LineBuffer<string> {
  return new LineBuffer(
    lines.map((line) => ({ id: line, text: line, payload: line })),
  )
}

test("line buffer moves and clamps cursor", () => {
  const subject = buffer(["a", "b", "c"])

  subject.move(2)
  expect(subject.cursorIndex).toBe(2)

  subject.move(10)
  expect(subject.cursorIndex).toBe(2)

  subject.move(-10)
  expect(subject.cursorIndex).toBe(0)
})

test("line buffer keeps cursor visible", () => {
  const subject = buffer(["a", "b", "c", "d", "e"])

  subject.moveTo(4)
  subject.ensureVisible(3)

  expect(subject.scrollOffset).toBe(2)
  expect(subject.visibleLines(3).map((line) => line.line.text)).toEqual([
    "c",
    "d",
    "e",
  ])
})

test("line buffer search wraps and stores query", () => {
  const subject = buffer(["alpha", "beta", "gamma", "alphabet"])
  subject.setSearch("alpha")

  expect(subject.searchNext(true)).toBe(true)
  expect(subject.cursorIndex).toBe(0)

  expect(subject.searchNext()).toBe(true)
  expect(subject.cursorIndex).toBe(3)

  expect(subject.searchNext()).toBe(true)
  expect(subject.cursorIndex).toBe(0)
})
