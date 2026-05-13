export class CommentStore<Key> {
  private readonly comments = new Map<Key, string>()

  get size(): number {
    return this.comments.size
  }

  has(key: Key): boolean {
    return this.comments.has(key)
  }

  get(key: Key): string | undefined {
    return this.comments.get(key)
  }

  save(key: Key, value: string): void {
    const trimmed = value.trim()
    if (trimmed) this.comments.set(key, trimmed)
    else this.comments.delete(key)
  }

  delete(key: Key): boolean {
    return this.comments.delete(key)
  }

  clear(): void {
    this.comments.clear()
  }

  entries(): Array<[Key, string]> {
    return [...this.comments.entries()]
  }

  keys(): Key[] {
    return [...this.comments.keys()]
  }

  asReadonlyMap(): ReadonlyMap<Key, string> {
    return this.comments
  }
}
