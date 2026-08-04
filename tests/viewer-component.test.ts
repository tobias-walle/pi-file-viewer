import { expect, test } from "bun:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { ReviewFile } from "../extension/types.js"
import { FileViewerComponent } from "../extension/viewer-component.js"

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  getBgAnsi: () => "",
} as unknown as Theme

function createViewer(content: string): FileViewerComponent {
  const file: ReviewFile = {
    id: "test-file",
    kind: "file",
    path: "README.md",
    content,
    createdAt: 0,
  }

  return new FileViewerComponent({
    file,
    cwd: "/repo",
    theme,
    visibleHeight: 13,
    onClose: () => {},
    onHide: () => {},
    onRequestRender: () => {},
  })
}

test("CRLF and trailing spaces do not add visual rows", () => {
  const viewer = createViewer("first                    \r\nsecond")
  const lines = viewer.render(30, 20)

  expect(lines[4]).toContain("2 │ second")
})

test("footer modes use the remaining height without changing frame size", () => {
  const viewer = createViewer("first\nsecond")

  expect(viewer.render(80, 12)).toHaveLength(12)

  viewer.handleInput("c")
  expect(viewer.render(80, 12)).toHaveLength(12)

  viewer.handleInput("\u001b")
  viewer.handleInput("/")
  expect(viewer.render(80, 12)).toHaveLength(12)
})
