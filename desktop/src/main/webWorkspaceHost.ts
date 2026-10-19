import { BrowserWindow, dialog, shell, type WebContents, type WebContentsView } from "electron";
import type { WebWorkspaceBounds, WebWorkspaceCommand, WebWorkspaceState } from "../shared/webWorkspace";
import { BROWSER_PARTITION, type BrowserPermissionRequestDetails, type BrowserSessionPermissionDelegate } from "./browserHostWindows";
import { createBrowserView } from "./browserView";

// These pages share the existing browser profile, but never acquire an agent
// tab, workdir, debugger, or automation turn. Their lifetime is the shell's.
type WorkspacePage = {
  id: string;
  owner: BrowserWindow;
  view: WebContentsView;
  contents: WebContents;
  bounds: WebWorkspaceBounds | null;
  requestedURL: string;
  error?: string;
  popups: Set<BrowserWindow>;
};

type PermissionOwner = { page: WorkspacePage; grants: Set<string> };

// Resource-scoped capabilities (media, files, devices, external apps, etc.)
// always ask again. Granting one microphone or file is not a blanket grant.
const TAB_PERMISSIONS = new Set(["notifications", "geolocation", "geolocation-approximate", "fullscreen", "screen-wake-lock", "persistent-storage"]);

function websiteURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Website destinations support HTTP and HTTPS addresses only.");
  }
  if (url.username || url.password) throw new Error("Website addresses cannot include credentials.");
  return url.href;
}

function requestOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export class WebWorkspaceHost implements BrowserSessionPermissionDelegate {
  private pages = new Map<string, WorkspacePage>();
  private contentsOwners = new Map<number, PermissionOwner>();
  private observedOwners = new Set<number>();
  private externalPrompts = new Set<number>();
  private permissionPrompts = new Set<number>();

  constructor(
    private readonly onState: (owner: BrowserWindow, state: WebWorkspaceState) => void,
    private readonly onFocusAddress: (owner: BrowserWindow, id: string) => void,
  ) {}

  open(owner: BrowserWindow, destination: { id: string; url: string }): WebWorkspaceState {
    if (typeof destination?.id !== "string" || !destination.id.trim() || destination.id.length > 256) {
      throw new Error("A website destination ID is required.");
    }
    const url = websiteURL(destination.url);
    const existing = this.pages.get(destination.id);
    if (existing) {
      if (existing.owner !== owner) throw new Error("This website belongs to another window.");
      return this.state(existing);
    }
    this.observeOwner(owner);
    const view = createBrowserView();
    const page: WorkspacePage = {
      id: destination.id, owner, view, contents: view.webContents, bounds: null, requestedURL: url, popups: new Set(),
    };
    this.pages.set(page.id, page);
    view.setVisible(false);
    owner.contentView.addChildView(view);
    this.secureContents(page, page.contents);
    page.contents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key.toLowerCase() === "l"
        && (process.platform === "darwin" ? input.meta : input.control) && !input.alt && !input.shift) {
        event.preventDefault();
        owner.webContents.focus();
        this.onFocusAddress(owner, page.id);
      }
    });
    const emit = () => this.emit(page);
    page.contents.on("did-start-loading", () => { page.error = undefined; emit(); });
    page.contents.on("did-stop-loading", emit);
    page.contents.on("did-navigate", emit);
    page.contents.on("did-navigate-in-page", emit);
    page.contents.on("page-title-updated", emit);
    page.contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      // ERR_ABORTED is normal when the user stops or supersedes a navigation.
      if (!isMainFrame || code === -3) return;
      page.error = description || "The website could not be loaded.";
      emit();
    });
    page.contents.on("render-process-gone", () => {
      page.error = "The website stopped responding. Reload to try again.";
      emit();
    });
    // A site's window.close() can destroy contents independently of the shell.
    // Remove its entry so selecting this destination can create a fresh page.
    page.contents.once("destroyed", () => {
      if (this.pages.get(page.id) !== page) return;
      this.close(owner, page.id);
      if (!owner.isDestroyed()) this.onState(owner, {
        id: page.id, url: page.requestedURL, title: "", loading: false,
        canGoBack: false, canGoForward: false, error: "The website closed this page. Reopen it to continue.",
      });
    });
    this.navigate(page, url);
    return this.state(page);
  }

  reportBounds(owner: BrowserWindow, id: string, bounds: WebWorkspaceBounds | null): void {
    // Unmount cleanup may follow destination removal or the site's self-close.
    if (bounds === null && !this.pages.has(id)) return;
    const page = this.page(owner, id);
    if (bounds !== null && ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
      throw new Error("Website bounds must be finite numbers.");
    }
    // Each renderer host owns its visibility. Independent primary/auxiliary
    // views may coexist; a delayed hide only changes the destination it names.
    page.bounds = bounds;
    this.layout(page);
  }

  command(owner: BrowserWindow, id: string, command: WebWorkspaceCommand, url?: string): WebWorkspaceState {
    const page = this.page(owner, id);
    const contents = page.contents;
    switch (command) {
      case "navigate":
        this.navigate(page, websiteURL(url ?? ""));
        break;
      case "back":
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        break;
      case "forward":
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        break;
      case "reload":
        page.error = undefined;
        contents.reload();
        break;
      case "stop":
        contents.stop();
        break;
      default:
        throw new Error("Unsupported website command.");
    }
    this.emit(page);
    return this.state(page);
  }

  close(owner: BrowserWindow, id: string): void {
    const page = this.pages.get(id);
    if (!page) return;
    if (page.owner !== owner) throw new Error("This website belongs to another window.");
    this.pages.delete(id);
    for (const popup of page.popups) if (!popup.isDestroyed()) popup.destroy();
    if (!owner.isDestroyed()) owner.contentView.removeChildView(page.view);
    if (!page.contents.isDestroyed()) page.contents.close();
  }

  destroyAll(): void {
    for (const page of [...this.pages.values()]) this.close(page.owner, page.id);
  }

  ownsWebContents(id: number): boolean {
    return this.contentsOwners.has(id);
  }

  checkPermission(contents: WebContents, permission: string, requestingOrigin: string): boolean {
    const origin = requestOrigin(requestingOrigin);
    const topOrigin = requestOrigin(contents.getURL());
    return Boolean(origin && topOrigin && TAB_PERMISSIONS.has(permission)
      && this.contentsOwners.get(contents.id)?.grants.has(`${topOrigin}\n${origin}\n${permission}`));
  }

  requestPermission(
    contents: WebContents,
    permission: string,
    callback: (allowed: boolean) => void,
    details: BrowserPermissionRequestDetails,
  ): void {
    const owned = this.contentsOwners.get(contents.id);
    const origin = requestOrigin(details.requestingUrl);
    if (!owned || !origin || contents.isDestroyed() || this.permissionPrompts.has(contents.id)) {
      callback(false);
      return;
    }
    if (this.checkPermission(contents, permission, origin)) {
      callback(true);
      return;
    }
    const parent = BrowserWindow.fromWebContents(contents) ?? owned.page.owner;
    if (parent.isDestroyed() || !parent.isVisible() || parent.isMinimized()
      || (contents === owned.page.contents && !owned.page.bounds)) { callback(false); return; }
    const pageOrigin = requestOrigin(contents.getURL());
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    this.permissionPrompts.add(contents.id);
    void dialog.showMessageBox(parent, {
      type: "question",
      title: "Website permission",
      message: `${origin} wants to use ${permission}.`,
      detail: [
        ...(mediaTypes?.length ? [`Requested media: ${mediaTypes.join(", ")}.`] : []),
        ...("filePath" in details ? [`File: ${details.filePath} (${details.fileAccessType}).`] : []),
        ...("externalURL" in details ? [`Application link: ${details.externalURL}`] : []),
        ...(pageOrigin && pageOrigin !== origin ? [`Embedded in ${pageOrigin}.`] : []),
        TAB_PERMISSIONS.has(permission) ? "Allow for this website tab until it is closed?" : "Allow this request?",
      ].join("\n"),
      buttons: ["Deny", "Allow"], defaultId: 0, cancelId: 0, noLink: true,
    }).then(({ response }) => {
      const allowed = response === 1 && !contents.isDestroyed()
        && this.contentsOwners.get(contents.id) === owned
        && requestOrigin(contents.getURL()) === pageOrigin;
      if (allowed && TAB_PERMISSIONS.has(permission)) owned.grants.add(`${pageOrigin}\n${origin}\n${permission}`);
      callback(allowed);
    }, () => callback(false)).finally(() => { this.permissionPrompts.delete(contents.id); });
  }

  private page(owner: BrowserWindow, id: string): WorkspacePage {
    const page = this.pages.get(id);
    if (!page || page.owner !== owner || page.contents.isDestroyed()) throw new Error("The website is no longer open.");
    return page;
  }

  private state(page: WorkspacePage): WebWorkspaceState {
    return {
      id: page.id,
      url: page.contents.getURL() || page.requestedURL,
      title: page.contents.getTitle(),
      loading: page.contents.isLoading(),
      canGoBack: page.contents.navigationHistory.canGoBack(),
      canGoForward: page.contents.navigationHistory.canGoForward(),
      ...(page.error ? { error: page.error } : {}),
    };
  }

  private emit(page: WorkspacePage): void {
    if (this.pages.get(page.id) === page && !page.owner.isDestroyed() && !page.contents.isDestroyed()) {
      this.onState(page.owner, this.state(page));
    }
  }

  private navigate(page: WorkspacePage, url: string): void {
    page.error = undefined;
    page.requestedURL = url;
    void page.contents.loadURL(url).catch((error: Error & { code?: string }) => {
      if (error.code === "ERR_ABORTED" || this.pages.get(page.id) !== page) return;
      page.error = error.message;
      this.emit(page);
    });
  }

  private layout(page: WorkspacePage): void {
    const { owner, view, bounds } = page;
    if (owner.isDestroyed() || page.contents.isDestroyed()) return;
    if (!bounds || owner.isMinimized() || !owner.isVisible()) {
      if (page.contents.isFocused()) owner.webContents.focus();
      view.setVisible(false);
      return;
    }
    const zoom = owner.webContents.getZoomFactor();
    const [width, height] = owner.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
    const right = Math.max(x, Math.min(width, Math.round((bounds.x + bounds.width) * zoom)));
    const bottom = Math.max(y, Math.min(height, Math.round((bounds.y + bounds.height) * zoom)));
    view.setBounds({ x, y, width: right - x, height: bottom - y });
    view.setVisible(right > x && bottom > y);
  }

  private observeOwner(owner: BrowserWindow): void {
    const id = owner.webContents.id;
    if (this.observedOwners.has(id)) return;
    this.observedOwners.add(id);
    const layout = () => {
      for (const page of this.pages.values()) if (page.owner === owner) this.layout(page);
    };
    const closePages = () => {
      // A dead renderer cannot release extension-owned pages. New renderer
      // generations reopen saved destinations lazily using the same profile.
      for (const page of [...this.pages.values()]) if (page.owner === owner) this.close(owner, page.id);
    };
    owner.on("resize", layout);
    owner.on("show", layout);
    owner.on("hide", layout);
    owner.on("minimize", layout);
    owner.on("restore", layout);
    owner.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) closePages();
    });
    owner.webContents.on("render-process-gone", closePages);
    owner.once("closed", () => {
      closePages();
      this.observedOwners.delete(id);
    });
  }

  private secureContents(page: WorkspacePage, contents: WebContents): void {
    const contentsID = contents.id;
    this.contentsOwners.set(contentsID, { page, grants: new Set() });
    contents.once("destroyed", () => this.contentsOwners.delete(contentsID));
    contents.on("will-attach-webview", event => event.preventDefault());
    const guardNavigation = (event: Electron.Event, url: string) => {
      try { websiteURL(url); } catch {
        event.preventDefault();
        void this.openExternal(page, contents, url);
      }
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    contents.setWindowOpenHandler(({ url }) => {
      const parent = BrowserWindow.fromWebContents(contents) ?? page.owner;
      if (parent.isDestroyed() || !parent.isVisible() || parent.isMinimized()
        || (contents === page.contents && !page.bounds)) return { action: "deny" };
      if (url !== "about:blank") {
        try { websiteURL(url); } catch {
          void this.openExternal(page, contents, url);
          return { action: "deny" };
        }
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent: page.owner, width: 1000, height: 750, autoHideMenuBar: true,
          frame: true, alwaysOnTop: false, fullscreen: false,
          webPreferences: {
            partition: BROWSER_PARTITION, preload: "", contextIsolation: true,
            nodeIntegration: false, nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false, sandbox: true, webviewTag: false,
            webSecurity: true, allowRunningInsecureContent: false,
          },
        },
      };
    });
    contents.on("did-create-window", popup => {
      page.popups.add(popup);
      this.secureContents(page, popup.webContents);
      popup.once("closed", () => page.popups.delete(popup));
    });
  }

  private async openExternal(page: WorkspacePage, contents: WebContents, value: string): Promise<void> {
    // Never hand local files, executable URLs, or browser-internal schemes to
    // the OS. Custom application links still require an explicit user choice.
    let url: URL;
    try { url = new URL(value); } catch { return; }
    if (["http:", "https:", "file:", "javascript:", "data:", "blob:", "about:", "chrome:", "devtools:", "wuu-file:", "wuu-artifact:", "wuu-plugin:"].includes(url.protocol)
      || this.externalPrompts.has(contents.id) || page.owner.isDestroyed()) return;
    const origin = requestOrigin(contents.getURL());
    const parent = BrowserWindow.fromWebContents(contents) ?? page.owner;
    if (!parent.isVisible() || parent.isMinimized() || (contents === page.contents && !page.bounds)) return;
    this.externalPrompts.add(contents.id);
    try {
      const { response } = await dialog.showMessageBox(parent, {
        type: "question", title: "Open another application?",
        message: `This website wants to open a ${url.protocol.slice(0, -1)} link.`,
        detail: value, buttons: ["Cancel", "Open"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response === 1 && !contents.isDestroyed() && this.pages.get(page.id) === page
        && requestOrigin(contents.getURL()) === origin) await shell.openExternal(value);
    } catch (error) {
      console.warn("[web-workspace] Could not open external link", error);
    } finally {
      this.externalPrompts.delete(contents.id);
    }
  }
}
