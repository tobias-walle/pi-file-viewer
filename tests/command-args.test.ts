import { expect, test } from "bun:test"
import { parseCommandArgs } from "../extension/command-args.js"

test("parses generic command flags and leaves positionals", () => {
  const parsed = parseCommandArgs("main --guide -s", [
    { name: "guide", tokens: ["--guide"] },
    { name: "staged", tokens: ["--staged", "-s"] },
  ] as const)

  expect(parsed.flags.has("guide")).toBe(true)
  expect(parsed.flags.has("staged")).toBe(true)
  expect(parsed.flagOrder).toEqual(["guide", "staged"])
  expect(parsed.positionals).toEqual(["main"])
})

test("stops parsing flags after double dash", () => {
  const parsed = parseCommandArgs("--guide -- --staged", [
    { name: "guide", tokens: ["--guide"] },
    { name: "staged", tokens: ["--staged"] },
  ] as const)

  expect(parsed.flags.has("guide")).toBe(true)
  expect(parsed.flags.has("staged")).toBe(false)
  expect(parsed.positionals).toEqual(["--staged"])
})
