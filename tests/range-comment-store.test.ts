import { expect, test } from "bun:test"
import { RangeCommentStore } from "../extension/range-comment-store.js"

test("range comments can be found across their full range", () => {
  const comments = new RangeCommentStore<undefined>()
  comments.save("file", { start: 3, end: 5 }, "Comment", undefined)

  expect(comments.hasAt("file", 3)).toBe(true)
  expect(comments.hasAt("file", 5)).toBe(true)
  expect(comments.hasAt("file", 6)).toBe(false)
  expect(comments.findExact("file", { start: 5, end: 3 })?.text).toBe("Comment")
})

test("saving an overlapping range replaces all overlapping comments", () => {
  const comments = new RangeCommentStore<undefined>()
  comments.save("file", { start: 2, end: 4 }, "First", undefined)
  comments.save("file", { start: 6, end: 8 }, "Second", undefined)
  comments.save("file", { start: 4, end: 7 }, "Replacement", undefined)

  expect(comments.entries()).toEqual([
    {
      scope: "file",
      start: 4,
      end: 7,
      text: "Replacement",
      metadata: undefined,
    },
  ])
})

test("empty edits remove exact comments without removing partial overlaps", () => {
  const comments = new RangeCommentStore<undefined>()
  comments.save("file", { start: 2, end: 4 }, "Existing", undefined)

  comments.save("file", { start: 3, end: 5 }, "", undefined)
  expect(comments.size).toBe(1)

  comments.save("file", { start: 2, end: 4 }, "", undefined)
  expect(comments.size).toBe(0)
})
