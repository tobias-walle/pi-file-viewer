import { expect, test } from "bun:test"
import { formatReviewComments } from "../extension/comments.js"

test("formats review comments sorted by line", () => {
  expect(
    formatReviewComments(
      {
        id: "file",
        kind: "file",
        path: "src/file.ts",
        content: "",
        createdAt: 1,
      },
      [
        { line: 10, text: "Later" },
        { line: 2, text: "Earlier" },
      ],
    ),
  ).toBe(
    "Review comments for `src/file.ts`:\n\n" +
      "- `src/file.ts:2`: Earlier\n" +
      "- `src/file.ts:10`: Later\n",
  )
})
