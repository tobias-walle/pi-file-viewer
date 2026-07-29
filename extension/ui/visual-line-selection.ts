export interface VisualLineRange {
  startIndex: number
  endIndex: number
  count: number
}

export class VisualLineSelection {
  private anchorIndex: number | undefined

  get active(): boolean {
    return this.anchorIndex !== undefined
  }

  toggle(cursorIndex: number): void {
    if (this.active) this.exit()
    else this.anchorIndex = cursorIndex
  }

  exit(): void {
    this.anchorIndex = undefined
  }

  clamp(lineCount: number): void {
    if (this.anchorIndex === undefined) return
    if (lineCount <= 0) {
      this.exit()
      return
    }
    this.anchorIndex = clamp(this.anchorIndex, 0, lineCount - 1)
  }

  includes(index: number, cursorIndex: number): boolean {
    const range = this.range(cursorIndex)
    return (
      range !== undefined &&
      index >= range.startIndex &&
      index <= range.endIndex
    )
  }

  range(cursorIndex: number): VisualLineRange | undefined {
    if (this.anchorIndex === undefined) return undefined
    const startIndex = Math.min(this.anchorIndex, cursorIndex)
    const endIndex = Math.max(this.anchorIndex, cursorIndex)
    return { startIndex, endIndex, count: endIndex - startIndex + 1 }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
