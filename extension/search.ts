import type { Theme } from "@mariozechner/pi-coding-agent"

const ESC = String.fromCharCode(27)
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g")

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

export function lineHasSearchMatch(line: string, query: string): boolean {
  if (!query) return false
  return stripAnsi(line).toLowerCase().includes(query.toLowerCase())
}

export function findNextSearchMatchIndex(
  lines: string[],
  query: string,
  currentIndex: number,
  direction: 1 | -1,
  includeCurrent = false,
): number | undefined {
  if (!query || lines.length === 0) return undefined
  const startStep = includeCurrent ? 0 : 1

  for (let step = startStep; step < lines.length + startStep; step++) {
    const index =
      (currentIndex + step * direction + lines.length) % lines.length
    if (lineHasSearchMatch(lines[index] ?? "", query)) return index
  }

  return undefined
}

export function decorateSearchMatches(
  content: string,
  query: string,
  theme: Theme,
  restoreBg: string,
): string {
  if (!query) return content

  const ranges = getSearchMatchRanges(stripAnsi(content), query)
  if (ranges.length === 0) return content

  const searchBg = searchHighlightBg(theme)
  let rangeIndex = 0
  let visibleIndex = 0
  let output = ""

  for (let index = 0; index < content.length; index++) {
    if (content[index] === ESC) {
      const sequenceEnd = content.indexOf("m", index)
      if (sequenceEnd >= 0) {
        output += content.slice(index, sequenceEnd + 1)
        index = sequenceEnd
        continue
      }
    }

    const range = ranges[rangeIndex]
    if (range && visibleIndex === range.start) output += searchBg

    output += content[index]
    visibleIndex++

    if (range && visibleIndex === range.end) {
      output += restoreBg
      rangeIndex++
    }
  }

  return output
}

function getSearchMatchRanges(
  line: string,
  query: string,
): Array<{ start: number; end: number }> {
  if (!query) return []

  const lowerLine = line.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  let position = 0

  while (position < line.length) {
    const matchIndex = lowerLine.indexOf(lowerQuery, position)
    if (matchIndex < 0) break
    ranges.push({
      start: matchIndex,
      end: matchIndex + query.length,
    })
    position = matchIndex + query.length
  }

  return ranges
}

function searchHighlightBg(theme: Theme): string {
  if (theme.getColorMode() === "truecolor") return `${ESC}[48;2;90;74;0m`
  return `${ESC}[48;5;58m`
}
