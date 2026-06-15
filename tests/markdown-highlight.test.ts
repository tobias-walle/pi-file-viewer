import { expect, test } from "bun:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import {
  highlightForPath,
  highlightMarkdown,
} from "../extension/utils/markdown-highlight.js"

const theme = {
  fg: (_name: string, text: string) => `<${_name}>${text}</${_name}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
  italic: (text: string) => `<italic>${text}</italic>`,
} as unknown as Theme

test("highlights markdown block syntax", () => {
  expect(highlightMarkdown("# Title\n> quote\n- item", theme).join("\n")).toBe(
    "<mdHeading><bold># Title</bold></mdHeading>\n" +
      "<mdQuoteBorder>> </mdQuoteBorder>quote\n" +
      "<mdListBullet>-</mdListBullet> item",
  )
})

test("highlights markdown inline syntax", () => {
  expect(
    highlightMarkdown(
      "A `code` [link](https://example.com) **bold** and *em*",
      theme,
    )[0],
  ).toBe(
    "A <mdCode>`code`</mdCode> <mdLink>link</mdLink><mdLinkUrl> (https://example.com)</mdLinkUrl> <bold>bold</bold> and <italic>em</italic>",
  )
})

test("uses markdown highlighting for markdown paths", () => {
  expect(highlightForPath("# Title", "README.md", theme)[0]).toBe(
    "<mdHeading><bold># Title</bold></mdHeading>",
  )
})
