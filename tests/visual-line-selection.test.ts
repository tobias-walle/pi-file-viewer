import { expect, test } from "bun:test"
import { VisualLineSelection } from "../extension/ui/visual-line-selection.js"

test("visual line selection grows, shrinks, and reverses around its anchor", () => {
  const selection = new VisualLineSelection()

  selection.toggle(4)
  expect(selection.range(4)).toEqual({ startIndex: 4, endIndex: 4, count: 1 })
  expect(selection.range(7)).toEqual({ startIndex: 4, endIndex: 7, count: 4 })
  expect(selection.range(2)).toEqual({ startIndex: 2, endIndex: 4, count: 3 })
  expect(selection.includes(3, 2)).toBe(true)
  expect(selection.includes(5, 2)).toBe(false)
})

test("toggling visual line selection exits the mode", () => {
  const selection = new VisualLineSelection()

  selection.toggle(3)
  selection.toggle(8)

  expect(selection.active).toBe(false)
  expect(selection.range(8)).toBeUndefined()
})

test("visual line selection clamps its anchor when content changes", () => {
  const selection = new VisualLineSelection()

  selection.toggle(8)
  selection.clamp(4)
  expect(selection.range(2)).toEqual({ startIndex: 2, endIndex: 3, count: 2 })

  selection.clamp(0)
  expect(selection.active).toBe(false)
})
