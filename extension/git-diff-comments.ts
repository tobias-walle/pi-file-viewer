import { formatCommentBlock } from "./comment-format.js"
import type { GitChangedFile, GitDiffComment } from "./types.js"

export function formatGitDiffComments(
  files: GitChangedFile[],
  comments: GitDiffComment[],
): string {
  const order = new Map(files.map((file, index) => [file.id, index]))
  const sorted = [...comments].sort((a, b) => {
    const fileDiff =
      (order.get(a.fileId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.fileId) ?? Number.MAX_SAFE_INTEGER)
    if (fileDiff !== 0) return fileDiff
    return a.order - b.order
  })

  const lines = ["Review comments for git diff:", ""]
  for (const comment of sorted) {
    const location = comment.line
      ? `${comment.path}:${comment.line}${comment.removed ? " (removed)" : ""}`
      : `${comment.path}:file`
    lines.push(
      ...formatCommentBlock(location, comment.text, comment.lineContent),
      "",
    )
  }
  if (sorted.length > 0) lines.pop()
  return `${lines.join("\n")}\n`
}
