import { expect, test } from "bun:test"
import { formatGitDiffComments } from "../extension/git-diff-comments.js"

const files = [
  {
    id: "file",
    path: "src/file.ts",
    status: "M" as const,
    added: 1,
    removed: 1,
  },
]

test("formats git diff comments with line content", () => {
  expect(
    formatGitDiffComments(files, [
      {
        fileId: "file",
        path: "src/file.ts",
        line: 4,
        removed: true,
        lineContent: "-oldValue()",
        text: "Remove safely",
        order: 4,
      },
      {
        fileId: "file",
        path: "src/file.ts",
        line: 12,
        lineContent: "+const value = 1",
        text: "Fix naming",
        order: 12,
      },
    ]),
  ).toBe(
    "Review comments for git diff:\n\n" +
      "- File: `src/file.ts:4 (removed)`\n" +
      "  Snippet: `-oldValue()`\n" +
      "  Comment: Remove safely\n" +
      "\n" +
      "- File: `src/file.ts:12`\n" +
      "  Snippet: `+const value = 1`\n" +
      "  Comment: Fix naming\n",
  )
})
