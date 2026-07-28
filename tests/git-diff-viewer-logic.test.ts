import { expect, test } from "bun:test"
import { calculateGitDiffViewerLayout } from "../extension/git-diff-viewer.js"
import {
  resolveOverviewAction,
  resolveViewerAction,
} from "../extension/git-diff-viewer-logic.js"

test("viewer d/u keys move by half pages", () => {
  expect(
    resolveViewerAction("d", { hasSearch: false, half: 7, lastLine: 100 }),
  ).toEqual({ type: "moveViewerPage", delta: 7 })
  expect(
    resolveViewerAction("u", { hasSearch: false, half: 7, lastLine: 100 }),
  ).toEqual({ type: "moveViewerPage", delta: -7 })
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
