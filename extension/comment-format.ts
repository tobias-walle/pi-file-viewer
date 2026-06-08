export function inlineCode(text: string): string {
  const delimiter = "`".repeat(longestBacktickRun(text) + 1)
  const padding = text.includes("`") ? " " : ""
  return `${delimiter}${padding}${text}${padding}${delimiter}`
}

function longestBacktickRun(text: string): number {
  return Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  )
}

export function formatCommentBlock(
  location: string,
  comment: string,
  snippet?: string,
): string[] {
  const lines = [`- File: ${inlineCode(location)}`]
  if (snippet !== undefined && snippet.length > 0) {
    lines.push(`  Snippet: ${inlineCode(truncateSnippet(snippet))}`)
  }
  lines.push(`  Comment: ${comment}`)
  return lines
}

function truncateSnippet(text: string): string {
  const maxLength = 120
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}
