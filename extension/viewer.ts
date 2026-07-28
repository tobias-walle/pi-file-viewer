import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { OverlayHandle } from "@earendil-works/pi-tui"
import { formatReviewComments } from "./comments.js"
import { getReviewFile, subscribeReviewFiles } from "./registry.js"
import type { FileViewerResult, ReviewFile } from "./types.js"
import { FileViewerComponent } from "./viewer-component.js"

const OPEN_STREAMING_UPDATE_DELAY_MS = 100

const OVERLAY_OPTIONS = {
  overlay: true as const,
  overlayOptions: {
    width: "100%" as const,
    maxHeight: "100%" as const,
    anchor: "top-center" as const,
  },
}

type ActiveViewer = {
  handle: OverlayHandle
  hidden: boolean
}

let activeFileViewer: ActiveViewer | undefined

export function restoreFileViewer(): boolean {
  if (!activeFileViewer) return false
  if (activeFileViewer.hidden) {
    activeFileViewer.handle.setHidden(false)
    activeFileViewer.hidden = false
  }
  activeFileViewer.handle.focus()
  return true
}

function getDialogHeight(terminalRows: number): number {
  return Math.max(12, terminalRows)
}

export async function openFileViewer(
  ctx: ExtensionContext,
  file: ReviewFile,
): Promise<FileViewerResult> {
  if (restoreFileViewer()) return { comments: [] }

  let overlayHandle: OverlayHandle | undefined
  const result = await ctx.ui.custom<FileViewerResult>(
    (tui, theme, _kb, done) => {
      const initialDialogHeight = getDialogHeight(tui.terminal.rows)
      const component = new FileViewerComponent({
        file,
        cwd: ctx.sessionManager.getCwd() || ctx.cwd,
        theme,
        visibleHeight: Math.max(5, initialDialogHeight - 7),
        onClose: done,
        onHide: () => {
          if (!overlayHandle) return
          overlayHandle.setHidden(true)
          overlayHandle.unfocus()
          if (activeFileViewer) activeFileViewer.hidden = true
          ctx.ui.notify(
            "File viewer hidden. Run /view-file to show it again.",
            "info",
          )
        },
        onRequestRender: () => tui.requestRender(),
      })
      let pendingFile: ReviewFile | undefined
      let updateTimer: ReturnType<typeof setTimeout> | undefined
      const applyFileUpdate = (latestFile: ReviewFile) => {
        component.updateFile(latestFile)
        tui.requestRender()
      }
      const flushPendingUpdate = () => {
        updateTimer = undefined
        const latestFile = pendingFile
        pendingFile = undefined
        if (latestFile) applyFileUpdate(latestFile)
      }
      const unsubscribe = subscribeReviewFiles(() => {
        const latestFile = getReviewFile(file.id)
        if (!latestFile) return

        if (latestFile.status !== "streaming") {
          if (updateTimer) clearTimeout(updateTimer)
          updateTimer = undefined
          pendingFile = undefined
          applyFileUpdate(latestFile)
          return
        }

        pendingFile = latestFile
        if (!updateTimer) {
          updateTimer = setTimeout(
            flushPendingUpdate,
            OPEN_STREAMING_UPDATE_DELAY_MS,
          )
        }
      })

      return {
        render: (width: number) =>
          component.render(width, getDialogHeight(tui.terminal.rows)),
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data)
          tui.requestRender()
        },
        dispose: () => {
          if (updateTimer) clearTimeout(updateTimer)
          unsubscribe()
          if (activeFileViewer?.handle === overlayHandle) {
            activeFileViewer = undefined
          }
        },
      }
    },
    {
      ...OVERLAY_OPTIONS,
      onHandle: (handle) => {
        overlayHandle = handle
        activeFileViewer = { handle, hidden: false }
      },
    },
  )

  if (result.comments.length > 0) {
    ctx.ui.pasteToEditor(formatReviewComments(file, result.comments))
  }

  return result
}
