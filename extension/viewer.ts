import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import { formatReviewComments } from "./comments.js"
import { getReviewFile, subscribeReviewFiles } from "./registry.js"
import type { FileViewerResult, ReviewFile } from "./types.js"
import { FileViewerComponent } from "./viewer-component.js"

const OPEN_STREAMING_UPDATE_DELAY_MS = 100

const OVERLAY_OPTIONS = {
  overlay: true as const,
  overlayOptions: {
    width: "100%" as const,
    maxHeight: "85%" as const,
    anchor: "bottom-center" as const,
  },
}

function getDialogHeight(terminalRows: number): number {
  return Math.max(12, Math.floor(terminalRows * 0.82))
}

export async function openFileViewer(
  ctx: ExtensionContext,
  file: ReviewFile,
): Promise<FileViewerResult> {
  const result = await ctx.ui.custom<FileViewerResult>(
    (tui, theme, _kb, done) => {
      const initialDialogHeight = getDialogHeight(tui.terminal.rows)
      const component = new FileViewerComponent({
        file,
        cwd: ctx.sessionManager.getCwd() || ctx.cwd,
        theme,
        visibleHeight: Math.max(5, initialDialogHeight - 7),
        onClose: done,
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
        },
      }
    },
    OVERLAY_OPTIONS,
  )

  if (result.comments.length > 0) {
    ctx.ui.pasteToEditor(formatReviewComments(file, result.comments))
  }

  return result
}
