import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  type Focusable,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { highlightForPath } from "../shared/markdown-highlight.js";
import type {
  FileViewerResult,
  ReviewComment,
  ReviewFile,
  ReviewLineKind,
} from "./types.js";

type Mode = "view" | "comment" | "search";

interface FileViewerComponentOptions {
  file: ReviewFile;
  theme: Theme;
  visibleHeight: number;
  onClose: (result: FileViewerResult) => void;
  onRequestRender: () => void;
}

export class FileViewerComponent implements Focusable {
  private file: ReviewFile;
  private theme: Theme;
  private visibleHeight: number;
  private onClose: (result: FileViewerResult) => void;
  private onRequestRender: () => void;
  private selectedLine = 1;
  private scrollOffset = 0;
  private comments = new Map<number, string>();
  private highlightedLines: string[];
  private cachedWidth?: number;
  private cachedBodyHeight?: number;
  private cachedLines?: string[];
  private mode: Mode = "view";
  private commentInput = new Input();
  private searchInput = new Input();
  private searchQuery = "";
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.commentInput.focused = value && this.mode === "comment";
    this.searchInput.focused = value && this.mode === "search";
  }

  constructor(options: FileViewerComponentOptions) {
    this.file = options.file;
    this.theme = options.theme;
    this.visibleHeight = options.visibleHeight;
    this.onClose = options.onClose;
    this.onRequestRender = options.onRequestRender;
    this.highlightedLines = this.highlightFile();
    this.commentInput.onSubmit = (value) => this.saveCommentValue(value);
    this.commentInput.onEscape = () => this.cancelCommentInput();
    this.searchInput.onSubmit = (value) => this.saveSearchValue(value);
    this.searchInput.onEscape = () => this.cancelSearchInput();
  }

  handleInput(data: string): void {
    if (isCtrlC(data)) {
      this.close();
      return;
    }

    if (this.mode === "comment") {
      this.commentInput.handleInput(data);
      this.invalidateAndRender();
      return;
    }

    if (this.mode === "search") {
      this.searchInput.handleInput(data);
      this.invalidateAndRender();
      return;
    }

    this.handleViewInput(data);
  }

  render(width: number, height?: number): string[] {
    const innerWidth = Math.max(10, width);
    const bodyHeight = Math.max(5, (height ?? 30) - 7);
    this.visibleHeight = bodyHeight;
    this.ensureSelectedVisible();

    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedBodyHeight === bodyHeight
    ) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    lines.push(this.renderHeader(innerWidth));
    lines.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
    lines.push(...this.renderBody(innerWidth, bodyHeight));

    while (lines.length < bodyHeight + 2) {
      lines.push("");
    }

    lines.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
    lines.push(...this.renderFooter(innerWidth));

    const borderedLines = this.addHorizontalBorder(lines, width);
    this.cachedWidth = width;
    this.cachedBodyHeight = bodyHeight;
    this.cachedLines = borderedLines;
    return borderedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedBodyHeight = undefined;
    this.cachedLines = undefined;
  }

  updateFile(file: ReviewFile): void {
    if (
      file.content === this.file.content &&
      file.status === this.file.status
    ) {
      this.file = file;
      return;
    }

    this.file = file;
    this.highlightedLines = this.highlightFile();
    this.selectedLine = Math.min(this.selectedLine, this.lineCount());
    this.ensureSelectedVisible();
    this.invalidate();
  }

  private highlightFile(): string[] {
    return highlightForPath(this.file.content, this.file.path, this.theme);
  }

  private handleViewInput(data: string): void {
    if (this.handleViewControlInput(data)) return;
    if (this.handleViewNavigationInput(data)) return;
    this.handleViewActionInput(data);
  }

  private handleViewControlInput(data: string): boolean {
    if (!matchesKey(data, "escape") && data !== "q") return false;

    if (matchesKey(data, "escape") && this.searchQuery) {
      this.clearSearch();
    } else {
      this.close();
    }
    return true;
  }

  private handleViewNavigationInput(data: string): boolean {
    const halfPage = Math.max(1, Math.floor(this.visibleHeight / 2));

    if (matchesKey(data, "up") || data === "k") this.moveBy(-1);
    else if (matchesKey(data, "down") || data === "j") this.moveBy(1);
    else if (data === "u") this.moveByCentered(-halfPage);
    else if (data === "d") this.moveByCentered(halfPage);
    else if (data === "g") this.moveTo(1);
    else if (data === "G") this.moveTo(this.lineCount());
    else return false;

    return true;
  }

  private handleViewActionInput(data: string): void {
    if (data === "c" || matchesKey(data, "enter")) this.startCommentInput();
    else if (data === "/") this.startSearchInput();
    else if (data === "n") this.moveToSearchMatch(1);
    else if (data === "N") this.moveToSearchMatch(-1);
    else if (data === "x") this.removeSelectedComment();
    else if (data === "C") this.clearComments();
  }

  private renderHeader(width: number): string {
    const title = `${this.file.kind} ${this.file.path}`;
    const status = this.file.status === "streaming" ? "streaming, " : "";
    const meta = `${status}${this.lineCount()} lines, ${this.comments.size} comments`;
    const text = `${this.theme.fg("accent", this.theme.bold(title))} ${this.theme.fg("dim", meta)}`;
    return truncateToWidth(text, width, "");
  }

  private renderBody(width: number, height: number): string[] {
    const numberWidth = String(this.lineCount()).length;
    const lines: string[] = [];

    for (
      let lineNumber = this.scrollOffset + 1;
      lineNumber <= this.lineCount() && lines.length < height;
      lineNumber++
    ) {
      const renderedLines = this.renderLine(lineNumber, numberWidth, width);
      lines.push(...renderedLines.slice(0, height - lines.length));
    }

    return lines;
  }

  private renderLine(
    lineNumber: number,
    numberWidth: number,
    width: number,
  ): string[] {
    const isSelected = lineNumber === this.selectedLine;
    const hasComment = this.comments.has(lineNumber);
    const lineKind = this.file.changedLines?.get(lineNumber);
    const cursor = isSelected ? this.theme.fg("accent", ">") : " ";
    const marker = this.renderLineMarker(lineKind, hasComment);
    const lineNumberText = String(lineNumber).padStart(numberWidth);
    const gutter = `${cursor}${marker} ${this.theme.fg("muted", lineNumberText)} │ `;
    const continuationGutter = " ".repeat(visibleWidth(gutter));
    const contentWidth = Math.max(1, width - visibleWidth(gutter));
    const content = this.highlightedLines[lineNumber - 1] ?? "";
    const decoratedContent = this.decorateContent(content, lineKind);
    const renderedContent = this.searchQuery
      ? this.decorateSearchMatches(
          decoratedContent,
          isSelected ? this.theme.getBgAnsi("selectedBg") : RESET_BG,
        )
      : decoratedContent;
    const wrappedContent = wrapTextWithAnsi(renderedContent, contentWidth);
    const contentLines = wrappedContent.length > 0 ? wrappedContent : [""];
    const renderedLines = contentLines.map((contentLine, index) =>
      truncateToWidth(
        `${index === 0 ? gutter : continuationGutter}${contentLine}`,
        width,
        "",
      ),
    );

    if (!isSelected) return renderedLines;

    return renderedLines.map((line) => {
      const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
      return this.theme.bg("selectedBg", `${line}${padding}`);
    });
  }

  private renderLineMarker(
    lineKind: ReviewLineKind | undefined,
    hasComment: boolean,
  ): string {
    if (hasComment) return this.theme.fg("warning", "●");
    if (lineKind === "added") return this.theme.fg("success", "+");
    if (lineKind === "changed") return this.theme.fg("warning", "~");
    if (lineKind === "removed") return this.theme.fg("error", "-");
    return " ";
  }

  private decorateSearchMatches(content: string, restoreBg: string): string {
    if (!this.searchQuery) return content;

    const ranges = this.getSearchMatchRanges(stripAnsi(content));
    if (ranges.length === 0) return content;

    const searchBg = this.searchHighlightBg();
    let rangeIndex = 0;
    let visibleIndex = 0;
    let output = "";

    for (let index = 0; index < content.length; index++) {
      if (content[index] === ESC) {
        const sequenceEnd = content.indexOf("m", index);
        if (sequenceEnd >= 0) {
          output += content.slice(index, sequenceEnd + 1);
          index = sequenceEnd;
          continue;
        }
      }

      const range = ranges[rangeIndex];
      if (range && visibleIndex === range.start) output += searchBg;

      output += content[index];
      visibleIndex++;

      if (range && visibleIndex === range.end) {
        output += restoreBg;
        rangeIndex++;
      }
    }

    return output;
  }

  private searchHighlightBg(): string {
    if (this.theme.getColorMode() === "truecolor")
      return `${ESC}[48;2;90;74;0m`;
    return `${ESC}[48;5;58m`;
  }

  private getSearchMatchRanges(
    line: string,
  ): Array<{ start: number; end: number }> {
    if (!this.searchQuery) return [];

    const lowerLine = line.toLowerCase();
    const lowerQuery = this.searchQuery.toLowerCase();
    const ranges: Array<{ start: number; end: number }> = [];
    let position = 0;

    while (position < line.length) {
      const matchIndex = lowerLine.indexOf(lowerQuery, position);
      if (matchIndex < 0) break;
      ranges.push({
        start: matchIndex,
        end: matchIndex + this.searchQuery.length,
      });
      position = matchIndex + this.searchQuery.length;
    }

    return ranges;
  }

  private decorateContent(
    content: string,
    _lineKind: ReviewLineKind | undefined,
  ): string {
    return content;
  }

  private renderFooter(width: number): string[] {
    if (this.mode === "comment") {
      const prompt = this.theme.fg("warning", `Comment ${this.selectedLine}`);
      return [
        truncateToWidth(prompt, width, ""),
        ...this.commentInput.render(width),
        this.theme.fg("dim", "enter save · esc cancel"),
      ];
    }

    if (this.mode === "search") {
      return [
        this.theme.fg("warning", "Search"),
        ...this.searchInput.render(width),
        this.theme.fg("dim", "enter search · esc clear"),
      ];
    }

    const position = `${this.selectedLine}/${this.lineCount()}`;
    const help =
      "j/k move · d/u half page · g/G top/bottom · / search · n/N next/prev · enter/c comment · x remove · C clear · q close";
    return [
      truncateToWidth(
        `${this.theme.fg("muted", position)} ${this.theme.fg("dim", help)}`,
        width,
        "",
      ),
      this.theme.fg(
        "dim",
        "Markers: + added · ~ changed · - removed · ● comment",
      ),
    ];
  }

  private startCommentInput(): void {
    this.mode = "comment";
    this.commentInput.setValue(this.comments.get(this.selectedLine) ?? "");
    this.commentInput.focused = this.focused;
    this.invalidateAndRender();
  }

  private startSearchInput(): void {
    this.mode = "search";
    this.searchInput.setValue(this.searchQuery);
    this.searchInput.focused = this.focused;
    this.invalidateAndRender();
  }

  private saveSearchValue(value: string): void {
    const trimmed = value.trim();
    this.searchQuery = trimmed;
    this.mode = "view";
    this.searchInput.focused = false;
    if (trimmed) {
      this.moveToSearchMatch(1, true);
    }
    this.invalidateAndRender();
  }

  private cancelSearchInput(): void {
    this.mode = "view";
    this.clearSearch();
  }

  private clearSearch(): void {
    this.searchQuery = "";
    this.searchInput.setValue("");
    this.searchInput.focused = false;
    this.invalidateAndRender();
  }

  private saveCommentValue(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.comments.delete(this.selectedLine);
    } else {
      this.comments.set(this.selectedLine, trimmed);
    }

    this.mode = "view";
    this.commentInput.setValue("");
    this.commentInput.focused = false;
    this.invalidateAndRender();
  }

  private cancelCommentInput(): void {
    this.mode = "view";
    this.commentInput.setValue("");
    this.commentInput.focused = false;
    this.invalidateAndRender();
  }

  private removeSelectedComment(): void {
    if (!this.comments.delete(this.selectedLine)) return;
    this.invalidateAndRender();
  }

  private clearComments(): void {
    if (this.comments.size === 0) return;
    this.comments.clear();
    this.invalidateAndRender();
  }

  private close(): void {
    this.onClose({ comments: this.getComments() });
  }

  private getComments(): ReviewComment[] {
    return [...this.comments.entries()].map(([line, text]) => ({ line, text }));
  }

  private moveBy(amount: number): void {
    this.moveTo(this.selectedLine + amount);
  }

  private moveByCentered(amount: number): void {
    const nextLine = Math.max(
      1,
      Math.min(this.lineCount(), this.selectedLine + amount),
    );
    if (nextLine === this.selectedLine) return;
    this.selectedLine = nextLine;
    this.centerSelectedLine();
    this.invalidateAndRender();
  }

  private moveToSearchMatch(direction: 1 | -1, includeCurrent = false): void {
    if (!this.searchQuery) return;

    const matches = this.getSearchMatches();
    if (matches.length === 0) return;

    const nextLine =
      direction > 0
        ? (matches.find((line) =>
            includeCurrent
              ? line >= this.selectedLine
              : line > this.selectedLine,
          ) ?? matches[0])
        : ([...matches]
            .reverse()
            .find((line) =>
              includeCurrent
                ? line <= this.selectedLine
                : line < this.selectedLine,
            ) ?? matches[matches.length - 1]);

    this.moveToCentered(nextLine);
  }

  private getSearchMatches(): number[] {
    if (!this.searchQuery) return [];
    const query = this.searchQuery.toLowerCase();
    const matches: number[] = [];

    for (let index = 0; index < this.highlightedLines.length; index++) {
      const line = stripAnsi(this.highlightedLines[index] ?? "").toLowerCase();
      if (line.includes(query)) {
        matches.push(index + 1);
      }
    }

    return matches;
  }

  private moveTo(line: number): void {
    const nextLine = Math.max(1, Math.min(this.lineCount(), line));
    if (nextLine === this.selectedLine) return;
    this.selectedLine = nextLine;
    this.ensureSelectedVisible();
    this.invalidateAndRender();
  }

  private moveToCentered(line: number): void {
    const nextLine = Math.max(1, Math.min(this.lineCount(), line));
    if (nextLine === this.selectedLine) return;
    this.selectedLine = nextLine;
    this.centerSelectedLine();
    this.invalidateAndRender();
  }

  private centerSelectedLine(): void {
    const maxOffset = Math.max(0, this.lineCount() - this.visibleHeight);
    const centeredOffset =
      this.selectedLine - Math.ceil(this.visibleHeight / 2);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, centeredOffset));
  }

  private ensureSelectedVisible(): void {
    if (this.selectedLine <= this.scrollOffset) {
      this.scrollOffset = this.selectedLine - 1;
      return;
    }

    if (this.selectedLine > this.scrollOffset + this.visibleHeight) {
      this.scrollOffset = this.selectedLine - this.visibleHeight;
    }
  }

  private lineCount(): number {
    return Math.max(1, this.highlightedLines.length);
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.onRequestRender();
  }

  private addHorizontalBorder(lines: string[], width: number): string[] {
    const innerWidth = Math.max(0, width);
    const result = [this.theme.fg("border", "─".repeat(innerWidth))];

    for (const line of lines) {
      const text = truncateToWidth(line, innerWidth, "");
      const padding = Math.max(0, innerWidth - visibleWidth(text));
      result.push(`${text}${" ".repeat(padding)}`);
    }

    result.push(this.theme.fg("border", "─".repeat(innerWidth)));
    return result;
  }
}

const ESC = String.fromCharCode(27);
const RESET_BG = `${ESC}[49m`;
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function isCtrlC(data: string): boolean {
  return matchesKey(data, "ctrl+c");
}
