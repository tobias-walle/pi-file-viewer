import type { Theme } from "@earendil-works/pi-coding-agent"
import {
  getLanguageFromPath,
  highlightCode,
} from "@earendil-works/pi-coding-agent"

export function highlightForPath(
  content: string,
  path: string | undefined,
  theme: Theme,
): string[] {
  const language = path ? getLanguageFromPath(path) : undefined
  if (language === "markdown") return highlightMarkdown(content, theme)
  return highlightCode(content, language)
}

export function highlightMarkdown(content: string, theme: Theme): string[] {
  return content.split("\n").map((line) => highlightMarkdownLine(line, theme))
}

function highlightMarkdownLine(line: string, theme: Theme): string {
  if (line.trim().length === 0) return line

  if (/^(\s{0,3})#{1,6}(\s+.*)?$/.test(line)) {
    return theme.fg("mdHeading", theme.bold(line))
  }

  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return theme.fg("mdHr", line)
  }

  const quote = /^(\s{0,3}>+\s?)(.*)$/.exec(line)
  if (quote) {
    return `${theme.fg("mdQuoteBorder", quote[1] ?? "")}${highlightMarkdownInline(
      quote[2] ?? "",
      theme,
    )}`
  }

  const list = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/.exec(line)
  if (list) {
    return `${list[1] ?? ""}${theme.fg("mdListBullet", list[2] ?? "")}${
      list[3] ?? ""
    }${highlightMarkdownInline(list[4] ?? "", theme)}`
  }

  return highlightMarkdownInline(line, theme)
}

function highlightMarkdownInline(text: string, theme: Theme): string {
  const parts = text.split(/(`[^`]*`)/g)
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return theme.fg("mdCode", part)
      }
      return highlightMarkdownEmphasis(part, theme)
    })
    .join("")
}

function highlightMarkdownEmphasis(text: string, theme: Theme): string {
  return text
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_match: string, label: string, url: string) =>
        `${theme.fg("mdLink", label)}${theme.fg("mdLinkUrl", ` (${url})`)}`,
    )
    .replace(
      /(\*\*|__)(.+?)\1/g,
      (_match: string, _marker: string, value: string) => theme.bold(value),
    )
    .replace(/(\*|_)([^*_]+?)\1/g, (_match, _marker, value: string) =>
      theme.italic(value),
    )
}
