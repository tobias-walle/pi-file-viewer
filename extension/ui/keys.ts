import { matchesKey } from "@earendil-works/pi-tui"

export function isQuit(data: string): boolean {
  return data === "q" || matchesKey(data, "ctrl+c")
}

export function isEscape(data: string): boolean {
  return matchesKey(data, "escape")
}

export function isSubmit(data: string): boolean {
  return matchesKey(data, "enter")
}

export function isUp(data: string): boolean {
  return data === "k" || matchesKey(data, "up")
}

export function isDown(data: string): boolean {
  return data === "j" || matchesKey(data, "down")
}

export function isHalfPageUp(data: string): boolean {
  return data === "u" || matchesKey(data, "ctrl+u")
}

export function isHalfPageDown(data: string): boolean {
  return data === "d" || matchesKey(data, "ctrl+d")
}

export function isTop(data: string): boolean {
  return data === "g"
}

export function isBottom(data: string): boolean {
  return data === "G"
}
