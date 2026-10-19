/** Desktop-only website destinations, independent of agent browser ownership. */
export type WebWorkspaceBounds = { x: number; y: number; width: number; height: number };

export type WebWorkspaceState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
};

export type WebWorkspaceCommand = "back" | "forward" | "reload" | "stop" | "navigate";

export type WebWorkspaceApi = {
  /** Reopening a destination retains its current URL and navigation history. */
  open: (destination: { id: string; url: string }) => Promise<WebWorkspaceState>;
  /** CSS-pixel bounds; null hides this destination without closing its page. */
  reportBounds: (id: string, bounds: WebWorkspaceBounds | null) => Promise<void>;
  command: (id: string, command: WebWorkspaceCommand, url?: string) => Promise<WebWorkspaceState>;
  /** Remove a destination's page and its transient permission decisions. */
  close: (id: string) => Promise<void>;
  onState: (handler: (state: WebWorkspaceState) => void) => () => void;
  onFocusAddress: (handler: (id: string) => void) => () => void;
};
