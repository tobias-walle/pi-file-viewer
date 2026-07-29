import { expect, test } from "bun:test"
import { calculateGitDiffViewerLayout } from "../extension/git-diff-viewer.js"
import {
  resolveOverviewAction,
  resolveViewerAction,
} from "../extension/git-diff-viewer-logic.js"

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
