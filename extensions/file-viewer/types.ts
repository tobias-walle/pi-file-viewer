export type ReviewLineKind = "added" | "changed" | "removed";

export interface ReviewFileStats {
  added: number;
  removed: number;
}

export type ReviewFileStatus = "streaming" | "complete";

export interface ReviewFile {
  id: string;
  kind: "write" | "edit" | "file";
  path: string;
  content: string;
  changedLines?: Map<number, ReviewLineKind>;
  stats?: ReviewFileStats;
  status?: ReviewFileStatus;
  createdAt: number;
}

export interface ReviewComment {
  line: number;
  text: string;
}

export interface FileViewerResult {
  comments: ReviewComment[];
}
