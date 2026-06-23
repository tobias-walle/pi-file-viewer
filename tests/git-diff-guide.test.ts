import { expect, test } from "bun:test"
import { validateGitDiffGuideOutput } from "../extension/git-diff-guide.js"
import type { GitChangedFile } from "../extension/types.js"

const files: GitChangedFile[] = [
  {
    id: "M:extension/command-args.ts",
    path: "extension/command-args.ts",
    status: "M",
    added: 12,
    removed: 0,
  },
  {
    id: "M:extension/index.ts",
    path: "extension/index.ts",
    status: "M",
    added: 8,
    removed: 2,
  },
]

test("validates guide output with ranked review cues", () => {
  const result = validateGitDiffGuideOutput(
    "extension/command-args.ts\tDefines shared arg parsing. Check aliases and positional refs.\n" +
      "extension/index.ts\tWires guide generation before viewer launch. Check failure stops opening.",
    files,
  )

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.entries).toEqual([
    {
      path: "extension/command-args.ts",
      rank: 1,
      reason: "Defines shared arg parsing. Check aliases and positional refs.",
    },
    {
      path: "extension/index.ts",
      rank: 2,
      reason:
        "Wires guide generation before viewer launch. Check failure stops opening.",
    },
  ])
})

test("reports validation errors for invalid guide output", () => {
  const result = validateGitDiffGuideOutput(
    `extension/command-args.ts\t${"x".repeat(141)}\nunknown.ts\tUnknown path\nextension/command-args.ts\tDuplicate`,
    files,
  )

  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.errors).toContain(
    "Line 1 for extension/command-args.ts cue is 141 chars, max is 140",
  )
  expect(result.errors).toContain("Line 2 has unknown path: unknown.ts")
  expect(result.errors).toContain(
    "Line 3 duplicates path: extension/command-args.ts",
  )
  expect(result.errors).toContain("Missing path: extension/index.ts")
})
