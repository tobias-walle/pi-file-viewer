import { findNextSearchMatchIndex } from "../search.js"

export interface BufferLine<T = unknown> {
  id: string
  text: string
  payload: T
}

export interface BufferPosition {
  cursorIndex: number
  scrollOffset: number
}

export class LineBuffer<T> {
  cursorIndex = 0
  scrollOffset = 0
  searchQuery = ""

  constructor(public lines: BufferLine<T>[] = []) {}

  get length(): number {
    return this.lines.length
  }

  get selectedLine(): BufferLine<T> | undefined {
    return this.lines[this.cursorIndex]
  }

  setLines(lines: BufferLine<T>[]): void {
    this.lines = lines
    this.clamp()
  }

  setSearch(query: string): void {
    this.searchQuery = query.trim()
  }

  clearSearch(): void {
    this.searchQuery = ""
  }

  hasSearch(): boolean {
    return this.searchQuery.length > 0
  }

  move(delta: number): void {
    this.moveTo(this.cursorIndex + delta)
  }

  moveCentered(delta: number, visibleHeight: number): void {
    const previous = this.cursorIndex
    this.moveTo(this.cursorIndex + delta)
    if (this.cursorIndex !== previous) this.center(visibleHeight)
  }

  moveTo(index: number): void {
    this.cursorIndex = clamp(index, 0, this.maxIndex())
  }

  moveToTop(): void {
    this.moveTo(0)
  }

  moveToBottom(): void {
    this.moveTo(this.maxIndex())
  }

  searchNext(includeCurrent = false, visibleHeight?: number): boolean {
    return this.search(1, includeCurrent, visibleHeight)
  }

  searchPrevious(includeCurrent = false, visibleHeight?: number): boolean {
    return this.search(-1, includeCurrent, visibleHeight)
  }

  search(
    direction: 1 | -1,
    includeCurrent = false,
    visibleHeight?: number,
  ): boolean {
    if (!this.searchQuery || this.lines.length === 0) return false
    const nextIndex = findNextSearchMatchIndex(
      this.lines.map((line) => line.text),
      this.searchQuery,
      this.cursorIndex,
      direction,
      includeCurrent,
    )
    if (nextIndex === undefined) return false
    this.cursorIndex = nextIndex
    if (visibleHeight !== undefined) this.center(visibleHeight)
    return true
  }

  ensureVisible(visibleHeight: number): void {
    this.clamp()
    if (this.cursorIndex < this.scrollOffset) {
      this.scrollOffset = this.cursorIndex
      return
    }
    if (this.cursorIndex >= this.scrollOffset + visibleHeight) {
      this.scrollOffset = this.cursorIndex - visibleHeight + 1
    }
  }

  center(visibleHeight: number): void {
    const maxOffset = Math.max(0, this.length - visibleHeight)
    const centeredOffset = this.cursorIndex - Math.ceil(visibleHeight / 2)
    this.scrollOffset = clamp(centeredOffset, 0, maxOffset)
  }

  visibleLines(
    visibleHeight: number,
  ): Array<{ index: number; line: BufferLine<T> }> {
    this.ensureVisible(visibleHeight)
    const result: Array<{ index: number; line: BufferLine<T> }> = []
    const end = Math.min(this.scrollOffset + visibleHeight, this.lines.length)
    for (let index = this.scrollOffset; index < end; index++) {
      const line = this.lines[index]
      if (line) result.push({ index, line })
    }
    return result
  }

  getPosition(): BufferPosition {
    return { cursorIndex: this.cursorIndex, scrollOffset: this.scrollOffset }
  }

  setPosition(position: BufferPosition | undefined): void {
    this.cursorIndex = position?.cursorIndex ?? 0
    this.scrollOffset = position?.scrollOffset ?? 0
    this.clamp()
  }

  clamp(): void {
    this.cursorIndex = clamp(this.cursorIndex, 0, this.maxIndex())
    this.scrollOffset = clamp(
      this.scrollOffset,
      0,
      Math.max(0, this.maxIndex()),
    )
  }

  private maxIndex(): number {
    return Math.max(0, this.lines.length - 1)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
