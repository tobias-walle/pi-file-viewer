import { expect, test } from "bun:test"
import {
  addReviewFile,
  clearReviewFiles,
  getReviewFile,
  getReviewFiles,
  setReviewScope,
  subscribeReviewFiles,
} from "../extension/registry.js"
import type { ReviewFile } from "../extension/types.js"

function reviewFile(id: string, createdAt: number): ReviewFile {
  return {
    id,
    kind: "write",
    path: `${id}.ts`,
    content: id,
    createdAt,
  }
}

test("keeps review files isolated by scope", () => {
  setReviewScope("session-a")
  clearReviewFiles()
  addReviewFile(reviewFile("a", 1))

  setReviewScope("session-b")
  clearReviewFiles()
  addReviewFile(reviewFile("b", 2))

  expect(getReviewFiles().map((file) => file.id)).toEqual(["b"])
  expect(getReviewFile("a")).toBeUndefined()

  setReviewScope("session-a")
  expect(getReviewFiles().map((file) => file.id)).toEqual(["a"])
})

test("replaces existing files while preserving original creation time", () => {
  setReviewScope("replace-test")
  clearReviewFiles()

  addReviewFile(reviewFile("same", 100))
  addReviewFile({ ...reviewFile("same", 200), content: "updated" })

  expect(getReviewFiles()).toEqual([
    expect.objectContaining({ id: "same", content: "updated", createdAt: 100 }),
  ])
})

test("notifies only listeners in the active scope", () => {
  let callsA = 0
  let callsB = 0

  setReviewScope("listener-a")
  clearReviewFiles()
  const unsubscribeA = subscribeReviewFiles(() => callsA++)

  setReviewScope("listener-b")
  clearReviewFiles()
  const unsubscribeB = subscribeReviewFiles(() => callsB++)

  addReviewFile(reviewFile("b", 1))
  expect(callsA).toBe(0)
  expect(callsB).toBe(1)

  setReviewScope("listener-a")
  addReviewFile(reviewFile("a", 1))
  expect(callsA).toBe(1)
  expect(callsB).toBe(1)

  unsubscribeA()
  unsubscribeB()
})
