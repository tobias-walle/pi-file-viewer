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
      "### `src/file.ts:4 (removed)`\n\n" +
      "    -oldValue()\n\n" +
      "> Remove safely\n" +
      "\n" +
      "### `src/file.ts:12`\n\n" +
      "    +const value = 1\n\n" +
      "> Fix naming\n",
  )
})

test("formats git diff range comments", () => {
  expect(
    formatGitDiffComments(files, [
      {
        fileId: "file",
        path: "src/file.ts",
        line: 12,
        endLine: 14,
        location: "src/file.ts:12-14",
        lineContent: "+first\n+second\n+third",
        text: "Keep these lines together\nDo not split them",
        order: 12,
      },
    ]),
  ).toBe(
    "Review comments for git diff:\n\n" +
      "### `src/file.ts:12-14`\n\n" +
      "    +first\n" +
      "    +second\n" +
      "    +third\n\n" +
      "> Keep these lines together\n" +
      "> Do not split them\n",
  )
})
