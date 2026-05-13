import type { Theme } from "@mariozechner/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui"

export function borderLine(theme: Theme, width: number): string {
  return theme.fg("border", "─".repeat(width))
}

export function separatorLine(theme: Theme, width: number): string {
  return theme.fg("borderMuted", "─".repeat(width))
}

export function renderHeader(
  theme: Theme,
  title: string,
  meta: string,
  width: number,
): string {
  const text = `${theme.fg("accent", theme.bold(title))}${meta ? ` ${theme.fg("dim", meta)}` : ""}`
  return truncateToWidth(text, width, "")
}

export function footerHint(theme: Theme, hint: string, width: number): string {
  return truncateToWidth(theme.fg("dim", hint), width, "")
}

export function fillSelected(
  theme: Theme,
  line: string,
  width: number,
): string {
  return theme.bg("selectedBg", padToWidth(line, width))
}

export function padToWidth(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`
}

export function center(text: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2))
  return `${" ".repeat(padding)}${text}`
}

export function shortenLeft(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text
  return `…${text.slice(Math.max(0, text.length - width + 1))}`
}
