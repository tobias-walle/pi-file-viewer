import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatReviewComments } from "./comments.js";
import { getReviewFile, subscribeReviewFiles } from "./registry.js";
import type { FileViewerResult, ReviewFile } from "./types.js";
import { FileViewerComponent } from "./viewer-component.js";

const OVERLAY_OPTIONS = {
  overlay: true as const,
  overlayOptions: {
    width: "100%" as const,
    maxHeight: "85%" as const,
    anchor: "bottom-center" as const,
  },
};

function getDialogHeight(terminalRows: number): number {
  return Math.max(12, Math.floor(terminalRows * 0.82));
}

export async function openFileViewer(
  ctx: ExtensionContext,
  file: ReviewFile,
): Promise<FileViewerResult> {
  const result = await ctx.ui.custom<FileViewerResult>(
    (tui, theme, _kb, done) => {
      const dialogHeight = getDialogHeight(tui.terminal.rows);
      const component = new FileViewerComponent({
        file,
        theme,
        visibleHeight: Math.max(5, dialogHeight - 7),
        onClose: done,
        onRequestRender: () => tui.requestRender(),
      });
      const unsubscribe = subscribeReviewFiles(() => {
        const latestFile = getReviewFile(file.id);
        if (!latestFile) return;
        component.updateFile(latestFile);
        tui.requestRender();
      });

      return {
        render: (width: number) => component.render(width, dialogHeight),
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data);
          tui.requestRender();
        },
        dispose: unsubscribe,
      };
    },
    OVERLAY_OPTIONS,
  );

  if (result.comments.length > 0) {
    ctx.ui.pasteToEditor(formatReviewComments(file, result.comments));
  }

  return result;
}
