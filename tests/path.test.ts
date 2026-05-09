import { expect, test } from "bun:test"
import { join } from "node:path"
import { resolvePath } from "../extension/path.js"

test("resolves relative paths against cwd and leaves absolute paths unchanged", () => {
  expect(resolvePath("src/index.ts", "/repo")).toBe(
    join("/repo", "src/index.ts"),
  )
  expect(resolvePath("/tmp/file.ts", "/repo")).toBe("/tmp/file.ts")
})
