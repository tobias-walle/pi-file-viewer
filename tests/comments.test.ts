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
      "- File: `src/file.ts:2`\n" +
      "  Snippet: `const earlier = 1`\n" +
      "  Comment: Earlier\n" +
      "\n" +
      "- File: `src/file.ts:10`\n" +
      "  Snippet: `const later = 2`\n" +
      "  Comment: Later\n",
  )
})
