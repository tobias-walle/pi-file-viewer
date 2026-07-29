import { expect, test } from "bun:test"
import { formatReviewComments } from "../extension/comments.js"

test("formats review comments sorted by line", () => {
  expect(
    formatReviewComments(
      {
        id: "file",
        kind: "file",
        path: "src/file.ts",
        content:
          "first\nconst earlier = 1\nthird\nfourth\nfifth\nsixth\nseventh\neighth\nninth\nconst later = 2",
        createdAt: 1,
      },
      [
        { line: 10, text: "Later" },
        { line: 2, text: "Earlier" },
      ],
    ),
  ).toBe(
    "Review comments for `src/file.ts`:\n\n" +
      "### `src/file.ts:2`\n\n" +
      "    const earlier = 1\n\n" +
      "> Earlier\n" +
      "\n" +
      "### `src/file.ts:10`\n\n" +
      "    const later = 2\n\n" +
      "> Later\n",
  )
})

test("formats a range comment with all selected lines without truncation", () => {
  const longMiddleLine = "middle ".repeat(20)
  expect(
    formatReviewComments(
      {
        id: "file",
        kind: "file",
        path: "src/file.ts",
        content: `first\nsecond\n${longMiddleLine}\nfourth`,
        createdAt: 1,
      },
      [{ line: 2, endLine: 4, text: "Treat this as one block" }],
    ),
  ).toBe(
    "Review comments for `src/file.ts`:\n\n" +
      "### `src/file.ts:2-4`\n\n" +
      "    second\n" +
      `    ${longMiddleLine}\n` +
      "    fourth\n\n" +
      "> Treat this as one block\n",
  )
})
