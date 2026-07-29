import { formatCommentBlock } from "./comment-format.js"
import type { ReviewComment, ReviewFile } from "./types.js"

export function formatReviewComments(
  file: ReviewFile,
  comments: ReviewComment[],
): string {
  const sorted = [...comments].sort((a, b) => a.line - b.line)
  const lines = [`Review comments for \`${file.path}\`:`, ""]

  for (const comment of sorted) {
    const endLine = comment.endLine ?? comment.line
    const lineContent = lineContentForRange(file.content, comment.line, endLine)
    const location =
      comment.line === endLine
        ? `${file.path}:${comment.line}`
        : `${file.path}:${comment.line}-${endLine}`
    lines.push(...formatCommentBlock(location, comment.text, lineContent), "")
  }
  if (sorted.length > 0) lines.pop()

  return `${lines.join("\n")}\n`
}

function lineContentForRange(
  content: string,
  startLine: number,
  endLine: number,
): string | undefined {
  return content
    .split(/\r?\n/)
    .slice(startLine - 1, endLine)
    .join("\n")
}
