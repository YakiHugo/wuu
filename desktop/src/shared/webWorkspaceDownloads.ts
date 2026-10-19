export type WebWorkspaceDownloadState = {
  id: string;
  websiteId: string;
  filename: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  paused: boolean;
  canResume: boolean;
  done: boolean;
  startedAt: number;
};

export type WebWorkspaceDownloadCommand = "pause" | "resume" | "cancel" | "open" | "reveal";
