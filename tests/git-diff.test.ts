import { expect, test } from "bun:test"
import {
  applyNumstat,
  isGitBinaryDiff,
  parseGitDiffCompareRef,
  parseGitDiffViewArgs,
  parseNameStatus,
  parseUnifiedDiff,
} from "../extension/git-diff.js"

test("parses view-diff compare ref argument", () => {
  expect(parseGitDiffCompareRef("")).toBeUndefined()
  expect(parseGitDiffCompareRef("   ")).toBeUndefined()
  expect(parseGitDiffCompareRef(" main ")).toBe("main")
  expect(parseGitDiffCompareRef("origin/main")).toBe("origin/main")
})

test("parses view-diff staged and unstaged flags", () => {
  expect(parseGitDiffViewArgs("--staged")).toEqual({ scope: "staged" })
  expect(parseGitDiffViewArgs("-s main")).toEqual({
    compareRef: "main",
    scope: "staged",
  })
  expect(parseGitDiffViewArgs("--unstaged")).toEqual({ scope: "unstaged" })
  expect(parseGitDiffViewArgs("-u")).toEqual({ scope: "unstaged" })
})

test("parses git name status including renames", () => {
  const files = parseNameStatus(
    "M\textension/index.ts\nA\tnew.ts\nD\told.ts\nR100\tsrc/a.ts\tsrc/b.ts\n",
  )

  expect(files.map((file) => file.status)).toEqual(["M", "A", "D", "R"])
  expect(files[3]?.oldPath).toBe("src/a.ts")
  expect(files[3]?.path).toBe("src/b.ts")
})

test("applies numstat and binary markers", () => {
  const files = parseNameStatus("M\ta.ts\nM\tb.png\nR100\told.ts\tnew.ts\n")

  applyNumstat(files, "2\t1\ta.ts\n-\t-\tb.png\n0\t0\told.ts\tnew.ts\n")

  expect(files[0]?.added).toBe(2)
  expect(files[0]?.removed).toBe(1)
  expect(files[1]?.binary).toBe(true)
  expect(files[2]?.path).toBe("new.ts")
})

test("does not treat diff content containing binary marker text as binary", () => {
  expect(
    isGitBinaryDiff(`diff --git a/a.ts b/a.ts
@@ -1 +1 @@
+return diff.includes("Binary files ") || diff.includes("GIT binary patch")`),
  ).toBe(false)

  expect(
    isGitBinaryDiff("Binary files a/image.png and b/image.png differ"),
  ).toBe(true)
})

test("parses unified diff rows with stable line mapping", () => {
  const rows = parseUnifiedDiff(`diff --git a/a.ts b/a.ts
@@ -1,3 +1,4 @@
 one
-old
+new
+added
 three`)

  expect(rows.map((row) => row.kind)).toEqual([
    "hunk",
    "context",
    "removed",
    "added",
    "added",
    "context",
  ])
  expect(rows[2]?.oldLine).toBe(2)
  expect(rows[2]?.removed).toBe(true)
  expect(rows[3]?.newLine).toBe(2)
})
