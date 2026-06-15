import { Input } from "@earendil-works/pi-tui"

export class TextPrompt {
  readonly input = new Input()

  constructor(options: {
    onSubmit: (value: string) => void
    onCancel: () => void
  }) {
    this.input.onSubmit = options.onSubmit
    this.input.onEscape = options.onCancel
  }

  get focused(): boolean {
    return this.input.focused
  }

  set focused(value: boolean) {
    this.input.focused = value
  }

  start(value: string, focused = true): void {
    this.input.setValue(value)
    this.input.focused = focused
  }

  stop(options: { clear?: boolean } = {}): void {
    if (options.clear) this.input.setValue("")
    this.input.focused = false
  }

  handleInput(data: string): void {
    this.input.handleInput(data)
  }

  render(width: number): string[] {
    return this.input.render(width)
  }
}
