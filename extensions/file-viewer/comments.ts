import type { ReviewComment, ReviewFile } from "./types.js";

export function formatReviewComments(
  file: ReviewFile,
  comments: ReviewComment[],
): string {
  const sorted = [...comments].sort((a, b) => a.line - b.line);
  const lines = [`Review comments for \`${file.path}\`:`, ""];

  for (const comment of sorted) {
    lines.push(`- \`${file.path}:${comment.line}\`: ${comment.text}`);
  }

  return `${lines.join("\n")}\n`;
}
