import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  applyNumstat,
  buildFileRows,
  isGitBinaryDiff,
  loadGitChangedFiles,
  loadGitFileRows,
  parseGitDiffCompareRef,
  parseGitDiffViewArgs,
  parseNameStatus,
  parseUnifiedDiff,
} from "../extension/git-diff.js"
import type { GitChangedFile } from "../extension/types.js"

const execFileAsync = promisify(execFile)

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root })
  return result.stdout
}

test("parses view-diff compare ref argument", () => {
  expect(parseGitDiffCompareRef("")).toBeUndefined()
  expect(parseGitDiffCompareRef("   ")).toBeUndefined()
  expect(parseGitDiffCompareRef(" main ")).toBe("main")
  expect(parseGitDiffCompareRef("origin/main")).toBe("origin/main")
})

test("parses view-diff staged, unstaged, and guide flags", () => {
  expect(parseGitDiffViewArgs("--staged")).toEqual({ scope: "staged" })
  expect(parseGitDiffViewArgs("-s main")).toEqual({
    compareRef: "main",
    scope: "staged",
  })
  expect(parseGitDiffViewArgs("--unstaged")).toEqual({ scope: "unstaged" })
  expect(parseGitDiffViewArgs("-u")).toEqual({ scope: "unstaged" })
  expect(parseGitDiffViewArgs("--guide")).toEqual({
    guide: true,
    scope: "all",
  })
  expect(parseGitDiffViewArgs("-g")).toEqual({
    guide: true,
    scope: "all",
  })
  expect(parseGitDiffViewArgs("main --guide --staged")).toEqual({
    compareRef: "main",
    guide: true,
    scope: "staged",
  })
  expect(parseGitDiffViewArgs("--staged --unstaged")).toEqual({
    scope: "unstaged",
  })
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

test("marks changed lines while keeping full-file row semantics", () => {
  const file: GitChangedFile = {
    id: "M:a.ts",
    path: "a.ts",
    status: "M",
    added: 2,
    removed: 1,
  }
  const rows = buildFileRows("one\nnew\ninserted\nthree\n", file, [
    { kind: "removed", text: "old", oldLine: 2 },
    { kind: "added", text: "new", newLine: 2 },
    { kind: "added", text: "inserted", newLine: 3 },
  ])

  expect(rows.map((row) => row.kind)).toEqual(["file", "file", "file", "file"])
  expect(rows.map((row) => row.changeKind)).toEqual([
    undefined,
    "changed",
    "added",
    undefined,
  ])
  expect(rows.every((row) => row.deletionMarker === undefined)).toBe(true)
})

test("does not add deletion markers to replacement blocks", () => {
  const file: GitChangedFile = {
    id: "M:a.ts",
    path: "a.ts",
    status: "M",
    added: 1,
    removed: 2,
  }
  const rows = buildFileRows("one\nnew\nthree", file, [
    { kind: "context", text: "one", oldLine: 1, newLine: 1 },
    { kind: "removed", text: "old", oldLine: 2 },
    { kind: "removed", text: "also old", oldLine: 3 },
    { kind: "added", text: "new", newLine: 2 },
    { kind: "context", text: "three", oldLine: 4, newLine: 3 },
  ])

  expect(rows.every((row) => row.deletionMarker === undefined)).toBe(true)
  expect(rows[1]).toMatchObject({ changeKind: "changed" })
})

test("attaches pure deletion markers to the nearest surviving line", () => {
  const file: GitChangedFile = {
    id: "M:a.ts",
    path: "a.ts",
    status: "M",
    added: 0,
    removed: 1,
  }
  const middleDeletion = buildFileRows("one\nthree", file, [
    { kind: "context", text: "one", oldLine: 1, newLine: 1 },
    { kind: "removed", text: "two", oldLine: 2 },
    { kind: "context", text: "three", oldLine: 3, newLine: 2 },
  ])
  const topDeletion = buildFileRows("two", file, [
    { kind: "removed", text: "one", oldLine: 1 },
    { kind: "context", text: "two", oldLine: 2, newLine: 1 },
  ])
  const endDeletion = buildFileRows("one", file, [
    { kind: "context", text: "one", oldLine: 1, newLine: 1 },
    { kind: "removed", text: "two", oldLine: 2 },
  ])
  const multipleDeletions = buildFileRows("one\nthree\nfive", file, [
    { kind: "context", text: "one", oldLine: 1, newLine: 1 },
    { kind: "removed", text: "two", oldLine: 2 },
    { kind: "context", text: "three", oldLine: 3, newLine: 2 },
    { kind: "removed", text: "four", oldLine: 4 },
    { kind: "context", text: "five", oldLine: 5, newLine: 3 },
  ])

  expect(middleDeletion[0]?.deletionMarker).toBe("after")
  expect(topDeletion[0]?.deletionMarker).toBe("before")
  expect(endDeletion[0]?.deletionMarker).toBe("after")
  expect(multipleDeletions.map((row) => row.deletionMarker)).toEqual([
    "after",
    "after",
    undefined,
  ])
})

test("marks removed lines when viewing a deleted file", () => {
  const file: GitChangedFile = {
    id: "D:a.ts",
    path: "a.ts",
    status: "D",
    added: 0,
    removed: 1,
  }
  const rows = buildFileRows("one\nold", file, [
    { kind: "removed", text: "old", oldLine: 2 },
  ])

  expect(rows[1]).toMatchObject({
    kind: "file",
    changeKind: "removed",
    oldLine: 2,
    removed: true,
  })
  expect(rows[1]?.newLine).toBeUndefined()
})

test("loads file rows with correct Git scope and side semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-file-viewer-git-"))
  try {
    await git(root, "init", "--quiet")
    await git(root, "config", "user.email", "test@example.com")
    await git(root, "config", "user.name", "Test")
    await writeFile(join(root, "deleted.txt"), "head version\n")
    await writeFile(join(root, "staged.txt"), "before\n")
    await writeFile(join(root, "old-name.txt"), "renamed content\n")
    await git(root, "add", ".")
    await git(root, "commit", "--quiet", "-m", "initial")
    const base = (await git(root, "rev-parse", "HEAD")).trim()

    await writeFile(join(root, "deleted.txt"), "index version\nsecond\n")
    await git(root, "add", "deleted.txt")
    await unlink(join(root, "deleted.txt"))
    await writeFile(join(root, "staged.txt"), "after\nadded\n")
    await git(root, "add", "staged.txt")
    await git(root, "mv", "old-name.txt", "renamed.txt")
    await writeFile(join(root, "untracked.txt"), "new\nfile\n")

    const unstagedFiles = await loadGitChangedFiles(root, base, "unstaged")
    const deleted = unstagedFiles.find((file) => file.path === "deleted.txt")
    const untracked = unstagedFiles.find(
      (file) => file.path === "untracked.txt",
    )
    expect(deleted?.status).toBe("D")
    expect(untracked?.status).toBe("??")

    const deletedRows = (
      await loadGitFileRows(deleted as GitChangedFile, root, base, "unstaged")
    ).rows
    expect(deletedRows.map((row) => row.text)).toEqual([
      "index version",
      "second",
    ])
    expect(
      deletedRows.map(({ oldLine, newLine, removed, changeKind }) => ({
        oldLine,
        newLine,
        removed,
        changeKind,
      })),
    ).toEqual([
      {
        oldLine: 1,
        newLine: undefined,
        removed: true,
        changeKind: "removed",
      },
      {
        oldLine: 2,
        newLine: undefined,
        removed: true,
        changeKind: "removed",
      },
    ])

    const untrackedRows = (
      await loadGitFileRows(untracked as GitChangedFile, root, base, "unstaged")
    ).rows
    expect(untrackedRows.map((row) => row.changeKind)).toEqual([
      "added",
      "added",
    ])

    const stagedFiles = await loadGitChangedFiles(root, base, "staged")
    const staged = stagedFiles.find((file) => file.path === "staged.txt")
    const renamed = stagedFiles.find((file) => file.path === "renamed.txt")
    const stagedRows = (
      await loadGitFileRows(staged as GitChangedFile, root, base, "staged")
    ).rows
    expect(stagedRows.map((row) => row.changeKind)).toEqual([
      "changed",
      "added",
    ])
    const cachedDiffRows = await loadGitFileRows(
      staged as GitChangedFile,
      root,
      "invalid-base",
      "all",
      [
        { kind: "removed", text: "before", oldLine: 1 },
        { kind: "added", text: "after", newLine: 1 },
        { kind: "added", text: "added", newLine: 2 },
      ],
    )
    expect(cachedDiffRows.rows.map((row) => row.changeKind)).toEqual([
      "changed",
      "added",
    ])
    expect(renamed?.status).toBe("R")
    expect(
      (
        await loadGitFileRows(renamed as GitChangedFile, root, base, "staged")
      ).rows.map((row) => row.text),
    ).toEqual(["renamed content"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
