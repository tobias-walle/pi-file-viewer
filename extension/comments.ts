import { formatCommentBlock } from "./comment-format.js"
import type { ReviewComment, ReviewFile } from "./types.js"

export function formatReviewComments(
  file: ReviewFile,
  comments: ReviewComment[],
): string {
  const sorted = [...comments].sort((a, b) => a.line - b.line)
  const lines = [`Review comments for \`${file.path}\`:`, ""]

  for (const comment of sorted) {
    const lineContent = lineContentAt(file.content, comment.line)
    lines.push(
      ...formatCommentBlock(
        `${file.path}:${comment.line}`,
        comment.text,
        lineContent,
      ),
      "",
    )
  }
  if (sorted.length > 0) lines.pop()

  return `${lines.join("\n")}\n`
}

function lineContentAt(content: string, line: number): string | undefined {
  return content.split(/\r?\n/)[line - 1]
}
