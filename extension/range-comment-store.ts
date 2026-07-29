export interface LineRange {
  start: number
  end: number
}

export interface RangeComment<Metadata> extends LineRange {
  scope: string
  text: string
  metadata: Metadata
}

export class RangeCommentStore<Metadata> {
  private comments: RangeComment<Metadata>[] = []

  get size(): number {
    return this.comments.length
  }

  hasAt(scope: string, line: number): boolean {
    return this.comments.some(
      (comment) =>
        comment.scope === scope && line >= comment.start && line <= comment.end,
    )
  }

  findExact(
    scope: string,
    range: LineRange,
  ): RangeComment<Metadata> | undefined {
    const normalized = normalizeRange(range)
    return this.comments.find(
      (comment) =>
        comment.scope === scope &&
        comment.start === normalized.start &&
        comment.end === normalized.end,
    )
  }

  save(
    scope: string,
    range: LineRange,
    value: string,
    metadata: Metadata,
  ): void {
    const normalized = normalizeRange(range)
    const trimmed = value.trim()
    const exact = this.findExact(scope, normalized)

    if (!trimmed) {
      if (exact) this.comments = this.comments.filter((item) => item !== exact)
      return
    }

    this.comments = this.comments.filter(
      (comment) =>
        comment.scope !== scope || !rangesOverlap(comment, normalized),
    )
    this.comments.push({ scope, ...normalized, text: trimmed, metadata })
  }

  deleteAt(scope: string, line: number): boolean {
    const previousLength = this.comments.length
    this.comments = this.comments.filter(
      (comment) =>
        comment.scope !== scope || line < comment.start || line > comment.end,
    )
    return this.comments.length !== previousLength
  }

  clear(): void {
    this.comments = []
  }

  entries(): readonly RangeComment<Metadata>[] {
    return this.comments
  }
}

function normalizeRange(range: LineRange): LineRange {
  return {
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
  }
}

function rangesOverlap(left: LineRange, right: LineRange): boolean {
  return left.start <= right.end && right.start <= left.end
}
