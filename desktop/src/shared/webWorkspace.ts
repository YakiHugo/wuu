import type { WebWorkspaceLibraryApi } from "./webWorkspaceLibrary";
import type { WebWorkspaceDownloadCommand, WebWorkspaceDownloadState } from "./webWorkspaceDownloads";

export const WEB_WORKSPACE_TAB_LIMIT = 64;
export const WEB_WORKSPACE_ZOOM_MIN = 0.25;
export const WEB_WORKSPACE_ZOOM_MAX = 3;

/** CSS pixels: a local rectangle, or edge insets for a window-filling surface. */
export type WebWorkspaceBounds = { x: number; y: number } & (
  | { width: number; height: number }
  | { right: number; bottom: number }
);
export type WebWorkspaceFindResult = { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean };
export type WebWorkspaceFindOptions = { forward?: boolean; findNext?: boolean };

export type WebWorkspaceTabState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  agentControlled?: boolean;
  findResult?: WebWorkspaceFindResult;
  error?: string;
};

/** Navigation fields describe the active tab; id always names the destination. */
export type WebWorkspaceState = Omit<WebWorkspaceTabState, "zoomFactor"> & {
  zoomFactor?: number;
  tabs?: WebWorkspaceTabState[];
  activeTabId?: string;
  canReopenTab?: boolean;
};

export type WebWorkspaceDestination = { id: string; url: string; tabs?: boolean };
export type WebWorkspaceCommand = "back" | "forward" | "reload" | "reloadIgnoringCache" | "stop" | "navigate" | "focus" | "takeOver";

export type WebWorkspaceApi = {
  /** The preload and native host understand window-relative edge geometry. */
  supportsWindowInsets?: true;
  /** Reopening retains navigation. Only ribbon destinations opt into tab groups. */
  open: (destination: WebWorkspaceDestination) => Promise<WebWorkspaceState>;
  /** One current-page JPEG backdrop; null when hidden, stale, or unavailable. */
  capture: (id: string) => Promise<string | null>;
  /** CSS-pixel geometry; null hides this destination without closing its pages. */
  reportBounds: (id: string, bounds: WebWorkspaceBounds | null) => Promise<void>;
  setShortcutTarget: (id: string, active: boolean) => Promise<void>;
  command: (id: string, command: WebWorkspaceCommand, url?: string) => Promise<WebWorkspaceState>;
  createTab: (id: string, url?: string) => Promise<WebWorkspaceState>;
  selectTab: (id: string, tabId: string) => Promise<WebWorkspaceState>;
  closeTab: (id: string, tabId: string) => Promise<WebWorkspaceState>;
  reopenTab: (id: string) => Promise<WebWorkspaceState>;
  find: (id: string, text: string, options?: WebWorkspaceFindOptions) => Promise<WebWorkspaceState>;
  stopFind: (id: string) => Promise<WebWorkspaceState>;
  setZoom: (id: string, factor: number) => Promise<WebWorkspaceState>;
  /** Remove every tab and transient permission decision belonging to a destination. */
  close: (id: string) => Promise<void>;
  onState: (handler: (state: WebWorkspaceState) => void) => () => void;
  onReveal: (handler: (id: string) => void) => () => void;
  onFocusAddress: (handler: (id: string) => void) => () => void;
  onFocusFind: (handler: (id: string) => void) => () => void;
  listDownloads: () => Promise<WebWorkspaceDownloadState[]>;
  downloadCommand: (id: string, command: WebWorkspaceDownloadCommand) => Promise<WebWorkspaceDownloadState[]>;
  onDownloads: (handler: (downloads: WebWorkspaceDownloadState[]) => void) => () => void;
  library: WebWorkspaceLibraryApi;
};
