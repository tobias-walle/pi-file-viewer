import { expect, test } from "bun:test"
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
