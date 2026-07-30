import { expect, test } from "bun:test"
import { calculateGitDiffViewerLayout } from "../extension/git-diff-viewer.js"
import {
  fileChangeMarker,
  findRowForSourceLine,
  resolveOverviewAction,
  resolveViewerAction,
  sourceLineAtRow,
} from "../extension/git-diff-viewer-logic.js"
import type { DiffRow } from "../extension/types.js"

test("viewer d/u keys move by half pages", () => {
  expect(
    resolveViewerAction("d", {
      hasSearch: false,
      visualMode: false,
      half: 7,
      lastLine: 100,
    }),
  ).toEqual({ type: "moveViewerPage", delta: 7 })
  expect(
    resolveViewerAction("u", {
      hasSearch: false,
      visualMode: false,
      half: 7,
      lastLine: 100,
    }),
  ).toEqual({ type: "moveViewerPage", delta: -7 })
})

test("viewer v toggles visual mode and t toggles diff/file view", () => {
  const options = {
    hasSearch: false,
    visualMode: false,
    half: 7,
    lastLine: 100,
  }

  expect(resolveViewerAction("v", options)).toEqual({
    type: "visualMode",
    action: "toggle",
  })
  expect(resolveViewerAction("t", options)).toEqual({ type: "toggleViewMode" })
})

test("mode switching anchors hunk rows to the following source line", () => {
  const rows: DiffRow[] = [
    { kind: "context", text: "before", oldLine: 9, newLine: 9 },
    { kind: "hunk", text: "@@ -20,1 +20,1 @@" },
    { kind: "removed", text: "old", oldLine: 20 },
    { kind: "added", text: "new", newLine: 20 },
  ]

  expect(sourceLineAtRow(rows, 1)).toBe(20)
  expect(sourceLineAtRow(rows, 2)).toBe(20)
})

test("loading placeholders do not consume mode switch anchors", () => {
  const loadingRows: DiffRow[] = [
    { kind: "card", text: "Loading", message: "Please wait." },
  ]

  expect(findRowForSourceLine(loadingRows, 42)).toBeUndefined()
  expect(
    findRowForSourceLine([{ kind: "file", text: "line 42", newLine: 42 }], 42),
  ).toEqual({ index: 0, exact: true })
})

test("mode switching falls back to the preceding source line", () => {
  const rows: DiffRow[] = [
    { kind: "file", text: "last line", newLine: 42 },
    { kind: "hunk", text: "metadata" },
  ]

  expect(sourceLineAtRow(rows, 1)).toBe(42)
  expect(sourceLineAtRow([{ kind: "card", text: "empty" }], 0)).toBeUndefined()
})

test("file mode prefers line changes over deletion markers", () => {
  expect(
    fileChangeMarker({ kind: "file", text: "added", changeKind: "added" }),
  ).toEqual({ color: "success", text: "▎" })
  expect(
    fileChangeMarker({
      kind: "file",
      text: "changed",
      changeKind: "changed",
    }),
  ).toEqual({ color: "warning", text: "▎" })
  expect(
    fileChangeMarker({
      kind: "file",
      text: "deleted",
      deletionMarker: "after",
    }),
  ).toEqual({ color: "error", text: "▁" })
})

test("viewer escape exits visual mode before clearing search or changing focus", () => {
  expect(
    resolveViewerAction("\u001b", {
      hasSearch: true,
      visualMode: true,
      half: 7,
      lastLine: 100,
    }),
  ).toEqual({ type: "visualMode", action: "exit" })
})

test("overview d/u keys scroll the diff viewer", () => {
  expect(
    resolveOverviewAction("d", {
      hasFilter: false,
      viewerHalf: 7,
      lastIndex: 10,
    }),
  ).toEqual({ type: "moveViewerPage", delta: 7 })
  expect(
    resolveOverviewAction("u", {
      hasFilter: false,
      viewerHalf: 7,
      lastIndex: 10,
    }),
  ).toEqual({ type: "moveViewerPage", delta: -7 })
})

test("diff viewer layout derives scrollable body heights from chrome", () => {
  expect(calculateGitDiffViewerLayout(40)).toEqual({
    totalHeight: 40,
    overviewHeight: 8,
    overviewBodyHeight: 5,
    viewerHeight: 32,
    viewerBodyHeight: 27,
  })

  expect(calculateGitDiffViewerLayout(40, 2)).toEqual({
    totalHeight: 40,
    overviewHeight: 8,
    overviewBodyHeight: 5,
    viewerHeight: 32,
    viewerBodyHeight: 25,
  })
})
