import { app, shell, type BrowserWindow, type DownloadItem } from "electron";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WebWorkspaceDownloadCommand, WebWorkspaceDownloadState } from "../shared/webWorkspaceDownloads";

type Download = {
  owner: BrowserWindow;
  state: WebWorkspaceDownloadState;
  item?: DownloadItem;
  detach: () => void;
};

const HISTORY_LIMIT = 100;

/** Downloads belong to the shell window, so changing or closing tabs cannot
 * lose progress. Only the shared session's ownership router may start one. */
export class WebWorkspaceDownloads {
  private downloads = new Map<string, Download>();
  private owners = new Map<BrowserWindow, () => void>();

  constructor(private readonly onChange: (owner: BrowserWindow, items: WebWorkspaceDownloadState[]) => void) {}

  start(owner: BrowserWindow, websiteId: string, item: DownloadItem): void {
    if (owner.isDestroyed()) { item.cancel(); return; }
    // Leave savePath unset: Electron asks where to save, with its normal
    // overwrite confirmation. A website never chooses an on-disk destination.
    item.setSaveDialogOptions({ defaultPath: join(app.getPath("downloads"), basename(item.getFilename()) || "download") });
    this.observeOwner(owner);
    const download: Download = {
      owner,
      state: {
        id: randomUUID(), websiteId, filename: item.getFilename(), savePath: "",
        receivedBytes: 0, totalBytes: 0, state: "progressing", paused: false,
        canResume: false, done: false, startedAt: item.getStartTime() * 1000,
      },
      item,
      detach: () => { item.removeListener("updated", updated); item.removeListener("done", done); },
    };
    const updated = (): void => { this.refresh(download); this.emit(owner); };
    const done = (_event: Electron.Event, state: "completed" | "cancelled" | "interrupted"): void => {
      this.refresh(download);
      download.state = { ...download.state, state, done: true, paused: false, canResume: false };
      download.detach();
      download.item = undefined;
      // Release the callbacks' closure over the native DownloadItem as well.
      download.detach = () => {};
      this.prune(owner);
      this.emit(owner);
    };
    this.downloads.set(download.state.id, download);
    item.on("updated", updated);
    item.once("done", done);
    this.refresh(download);
    this.prune(owner);
    this.emit(owner);
  }

  list(owner: BrowserWindow): WebWorkspaceDownloadState[] {
    return [...this.downloads.values()]
      .filter(download => download.owner === owner)
      .map(download => ({ ...download.state }))
      .reverse();
  }

  async command(owner: BrowserWindow, id: string, command: WebWorkspaceDownloadCommand): Promise<void> {
    const download = this.downloads.get(id);
    if (!download || download.owner !== owner || owner.isDestroyed()) {
      throw new Error("This download is no longer available in this window.");
    }
    const item = download.item;
    switch (command) {
      case "pause":
        if (!item || item.getState() !== "progressing") throw new Error("This download cannot be paused.");
        item.pause();
        break;
      case "resume":
        if (!item || (!item.isPaused() && (item.getState() !== "interrupted" || !item.canResume()))) throw new Error("This download cannot resume. Download the file again from the website.");
        item.resume();
        break;
      case "cancel":
        if (!item) throw new Error("This download has already ended.");
        item.cancel();
        // cancel() may emit done synchronously and release the native item.
        break;
      case "open":
      case "reveal": {
        if (download.state.state !== "completed" || !download.state.savePath) {
          throw new Error("Wait for this download to finish before opening it.");
        }
        const path = download.state.savePath;
        const file = await stat(path).catch(() => undefined);
        if (!file?.isFile()) throw new Error("This file was moved or removed. Download it again from the website.");
        if (owner.isDestroyed()) return;
        // These are explicit shell UI actions, never download completion hooks.
        if (command === "reveal") shell.showItemInFolder(path);
        else {
          const error = await shell.openPath(path);
          if (error) throw new Error(error);
        }
        return;
      }
      default:
        throw new Error("Unsupported download command.");
    }
    this.refresh(download);
    this.emit(owner);
  }

  destroyAll(): void {
    for (const owner of [...this.owners.keys()]) this.releaseOwner(owner);
  }

  private refresh(download: Download): void {
    const item = download.item;
    if (!item) return;
    const savePath = item.getSavePath();
    download.state = {
      ...download.state,
      filename: savePath ? basename(savePath) : item.getFilename(),
      savePath,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      state: item.getState(),
      paused: item.isPaused(),
      canResume: item.isPaused() || item.canResume(),
    };
  }

  private observeOwner(owner: BrowserWindow): void {
    if (this.owners.has(owner)) return;
    const closed = (): void => this.releaseOwner(owner);
    this.owners.set(owner, closed);
    owner.once("closed", closed);
  }

  private releaseOwner(owner: BrowserWindow): void {
    const closed = this.owners.get(owner);
    if (closed) owner.removeListener("closed", closed);
    this.owners.delete(owner);
    for (const [id, download] of this.downloads) {
      if (download.owner !== owner) continue;
      this.downloads.delete(id);
      download.detach();
      download.item?.cancel();
    }
  }

  private prune(owner: BrowserWindow): void {
    const finished = [...this.downloads.values()].filter(download => download.owner === owner && download.state.done);
    for (const download of finished.slice(0, Math.max(0, finished.length - HISTORY_LIMIT))) {
      this.downloads.delete(download.state.id);
    }
  }

  private emit(owner: BrowserWindow): void {
    if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) this.onChange(owner, this.list(owner));
  }
}
