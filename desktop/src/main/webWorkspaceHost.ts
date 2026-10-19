import { BrowserWindow, Menu, clipboard, dialog, shell, type DownloadItem, type WebContents, type WebContentsView, type WebContentsViewConstructorOptions } from "electron";
import { randomUUID } from "node:crypto";
import { WEB_WORKSPACE_ZOOM_MIN, WEB_WORKSPACE_ZOOM_MAX, WEB_WORKSPACE_TAB_LIMIT } from "../shared/webWorkspace";
import type { WebWorkspaceBounds, WebWorkspaceCommand, WebWorkspaceDestination, WebWorkspaceFindOptions, WebWorkspaceFindResult, WebWorkspaceState, WebWorkspaceTabState } from "../shared/webWorkspace";
import { BROWSER_PARTITION, BROWSER_WORKSPACE_TAB_PREFIX, type BrowserWorkspaceSource, type BrowserWorkspaceAttachment, type BrowserViewHandle, type BrowserParentWindowHandle, type BrowserPermissionRequestDetails, type BrowserSessionPermissionDelegate } from "./browserHostWindows";
import { createBrowserView } from "./browserView";
import type { WebWorkspaceLibrary } from "./webWorkspaceLibrary";
import type { WebWorkspaceDownloads } from "./webWorkspaceDownloads";

// Website pages keep their native ownership. Explicit, turn-scoped automation
// borrows a live view; restored tabs create native views only when selected.
type WorkspaceTab = { id: string; url: string; title: string; zoomFactor: number; page?: WorkspacePage };
type WorkspaceGroup = {
  id: string;
  owner: BrowserWindow;
  tabbed: boolean;
  homeURL: string;
  tabs: WorkspaceTab[];
  activeTabId: string;
  bounds: WebWorkspaceBounds | null;
  closedTabs: { url: string; title: string; zoomFactor: number }[];
};
type AutomationRestriction = { active: boolean };
type WorkspacePage = {
  id: string;
  group: WorkspaceGroup;
  tab: WorkspaceTab;
  owner: BrowserWindow;
  view: WebContentsView;
  contents: WebContents;
  bounds: WebWorkspaceBounds | null;
  htmlFullscreen?: boolean;
  requestedURL: string;
  navigationGeneration: number;
  error?: string;
  findResult?: WebWorkspaceFindResult;
  findRequestId?: number;
  pendingClose?: { promise: Promise<void>; resolve: () => void };
  popups: Set<BrowserWindow>;
  automation?: { restriction: AutomationRestriction; reclaim(): void; layout(): void; agentInput(): boolean; external: boolean };
  inheritedAutomation?: readonly AutomationRestriction[];
};
type PermissionOwner = { page: WorkspacePage; grants: Set<string>; navigationGeneration: number };

// Resource-scoped media, files, devices, and external apps always ask again.
// Notifications are unsupported: Electron may check them without a contents
// owner, and this shared profile cannot safely grant unattributed access.
const TAB_PERMISSIONS = new Set(["geolocation", "geolocation-approximate", "fullscreen", "screen-wake-lock", "persistent-storage"]);
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function websiteURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Website destinations support HTTP and HTTPS addresses only.");
  if (url.username || url.password) throw new Error("Website addresses cannot include credentials.");
  return url.href;
}
function requestOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch { return undefined; }
}

export class WebWorkspaceHost implements BrowserSessionPermissionDelegate {
  private shortcutTargets = new Map<number, string>();
  private groups = new Map<string, WorkspaceGroup>();
  private pages = new Map<string, WorkspacePage>();
  private contentsOwners = new Map<number, PermissionOwner>();
  private observedOwners = new Set<number>();
  private externalPrompts = new Set<number>();
  private permissionPrompts = new Set<number>();

  constructor(
    private readonly onState: (owner: BrowserWindow, state: WebWorkspaceState) => void,
    private readonly onFocusAddress: (owner: BrowserWindow, id: string) => void,
    private readonly options: {
      onReveal?: (owner: BrowserWindow, id: string) => void;
      onFocusFind?: (owner: BrowserWindow, id: string) => void;
      onLibraryChange?: (owner: BrowserWindow) => void;
      library?: WebWorkspaceLibrary;
      downloads?: WebWorkspaceDownloads;
    } = {},
  ) {}

  /** Only live website pages from the nominated application window are discoverable. */
  browserSource(owner: () => BrowserWindow | null): BrowserWorkspaceSource {
    return {
      list: () => [...this.pages.values()]
        .filter(page => page.owner === owner() && !page.contents.isDestroyed() && !page.automation && !page.pendingClose)
        .map(page => ({ tab_id: BROWSER_WORKSPACE_TAB_PREFIX + page.tab.id, url: page.contents.getURL(), title: page.contents.getTitle(),
          workspace_id: page.group.id, active: page.group.activeTabId === page.tab.id, source: page.group.tabbed ? "website" : "plugin" })),
      attach: (tabID, reclaim, layout, agentInput): BrowserWorkspaceAttachment => {
        const page = [...this.pages.values()].find(page => BROWSER_WORKSPACE_TAB_PREFIX + page.tab.id === tabID && page.owner === owner());
        if (!page || page.contents.isDestroyed() || page.pendingClose) throw new Error("Workspace tab is no longer available");
        if (page.automation) throw new Error("Workspace tab is already attached to another task");
        if (page.contents.debugger.isAttached()) throw new Error("Workspace tab already has a debugger attached");
        const automation = { reclaim, layout, agentInput, external: false, restriction: { active: true } };
        page.automation = automation;
        const visible = () => Boolean(page.bounds && !page.owner.isDestroyed() && page.owner.isVisible() && !page.owner.isMinimized());
        this.emit(page.group);
        return {
          view: page.view as unknown as BrowserViewHandle,
          parent: page.owner as unknown as BrowserParentWindowHandle,
          visible,
          setExternalPresentation: external => { automation.external = external; },
          restore: () => this.layout(page),
          reveal: () => {
            if (this.groups.get(page.group.id) !== page.group || page.contents.isDestroyed()) return;
            this.activate(page.group, page.tab);
            this.emit(page.group);
            this.options.onReveal?.(page.owner, page.group.id);
          },
          release: () => {
            if (page.automation !== automation) return;
            automation.restriction.active = false;
            page.automation = undefined;
            if (!page.contents.isDestroyed()) {
              page.contents.setBackgroundThrottling(true);
              // Only visible layout reapplies tab zoom; releasing a hidden
              // same-origin sibling must not change the user's active page.
              this.layout(page);
            }
            this.emit(page.group);
          },
        };
      },
    };
  }

  open(owner: BrowserWindow, destination: WebWorkspaceDestination): WebWorkspaceState {
    if (typeof destination?.id !== "string" || !destination.id.trim() || destination.id.length > 256) throw new Error("A website destination ID is required.");
    const url = websiteURL(destination.url);
    const existing = this.groups.get(destination.id);
    if (existing) {
      if (existing.owner !== owner) throw new Error("This website belongs to another window.");
      if (existing.homeURL !== url) {
        existing.homeURL = url;
        this.navigate(this.ensurePage(existing, this.activeTab(existing)), url);
        this.emit(existing);
      }
      return this.state(existing);
    }
    this.observeOwner(owner);
    const tabbed = destination.tabs === true;
    const restored = tabbed ? this.options.library?.getSession(destination.id) : undefined;
    const tabs: WorkspaceTab[] = restored?.tabs.length
      ? restored.tabs.map(tab => ({ ...tab, zoomFactor: 1 }))
      : [{ id: randomUUID(), url, title: "", zoomFactor: 1 }];
    const activeTabId = tabs.some(tab => tab.id === restored?.activeTabId) ? restored!.activeTabId : tabs[0].id;
    if (restored?.homeURL && restored.homeURL !== url) {
      const active = tabs.find(tab => tab.id === activeTabId)!;
      active.url = url;
      active.title = "";
    }
    const group: WorkspaceGroup = {
      id: destination.id, owner, tabbed, homeURL: url, tabs, activeTabId,
      bounds: null, closedTabs: [],
    };
    this.groups.set(group.id, group);
    this.ensurePage(group, this.activeTab(group));
    this.emit(group);
    return this.state(group);
  }

  /** One bounded, in-memory backdrop for chrome overlays; no capture subscription. */
  async capture(owner: BrowserWindow, id: string): Promise<string | null> {
    const group = this.group(owner, id);
    const page = this.activeTab(group).page;
    if (!page || !page.bounds || page.automation?.external || page.contents.isDestroyed() || !owner.isVisible() || owner.isMinimized()) return null;
    const generation = page.navigationGeneration;
    const image = await page.contents.capturePage(undefined, { stayHidden: true });
    if (this.groups.get(id) !== group || this.activeTab(group).page !== page || page.contents.isDestroyed() || page.navigationGeneration !== generation || image.isEmpty()) return null;
    const size = image.getSize();
    const scale = Math.min(1, 1280 / Math.max(size.width, size.height));
    const jpeg = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toJPEG(65);
    return jpeg.length <= 1024 * 1024 ? `data:image/jpeg;base64,${jpeg.toString("base64")}` : null;
  }

  reportBounds(owner: BrowserWindow, id: string, bounds: WebWorkspaceBounds | null): void {
    if (bounds === null && !this.groups.has(id)) return;
    const group = this.group(owner, id);
    if (bounds !== null && ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error("Website bounds must be finite numbers.");
    group.bounds = bounds;
    this.layoutGroup(group);
  }

  setShortcutTarget(owner: BrowserWindow, id: string, active: boolean): void {
    if (active) {
      this.group(owner, id);
      this.shortcutTargets.set(owner.webContents.id, id);
    } else if (this.shortcutTargets.get(owner.webContents.id) === id) this.shortcutTargets.delete(owner.webContents.id);
  }

  /** Route keys consumed before DOM dispatch only while browser chrome has focus. */
  handleShellInput(contents: WebContents, event: Electron.Event, input: Electron.Input): boolean {
    const id = this.shortcutTargets.get(contents.id);
    const group = id ? this.groups.get(id) : undefined;
    if (!group || group.owner.webContents !== contents || !group.owner.isVisible() || group.owner.isMinimized()) return false;
    const key = input.key.toLowerCase();
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (input.alt) return false;
    const reload = key === "f5" || (modifier && key === "r");
    const zoom = modifier && ["+", "=", "-", "0"].includes(key);
    const closeTab = modifier && key === "w" && !input.shift && group.tabbed;
    if (!reload && !zoom && !closeTab) return false;
    // In particular, consume Cmd/Ctrl+W before the native window-menu Close
    // accelerator; waiting for the renderer's keydown can close the shell.
    event.preventDefault();
    if (input.type === "keyDown") {
      if (closeTab) void this.closeTab(group.owner, group.id, group.activeTabId).catch(error => console.warn("[web-workspace] Could not close tab", error));
      else if (reload) this.command(group.owner, group.id, input.shift ? "reloadIgnoringCache" : "reload");
      else if (key === "0") this.setZoom(group.owner, group.id, 1);
      else this.stepZoom(this.ensurePage(group, this.activeTab(group)), key === "-" ? -1 : 1);
    }
    return true;
  }

  command(owner: BrowserWindow, id: string, command: WebWorkspaceCommand, url?: string): WebWorkspaceState {
    const group = this.group(owner, id);
    const page = this.ensurePage(group, this.activeTab(group));
    const contents = page.contents;
    if (command !== "focus") page.automation?.reclaim();
    switch (command) {
      case "navigate": this.navigate(page, websiteURL(url ?? "")); break;
      case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case "reload":
      case "reloadIgnoringCache": {
        // A failed navigation can leave getURL() on the preceding document.
        // Retry the attempted destination, not that stale committed page.
        if (page.error && page.requestedURL !== contents.getURL()) this.navigate(page, page.requestedURL);
        else {
          page.error = undefined;
          if (command === "reloadIgnoringCache") contents.reloadIgnoringCache(); else contents.reload();
        }
        break;
      }
      case "stop": contents.stop(); break;
      case "takeOver": break;
      case "focus": if (page.bounds) contents.focus(); break;
      default: throw new Error("Unsupported website command.");
    }
    this.emit(group);
    return this.state(group);
  }

  createTab(owner: BrowserWindow, id: string, url?: string): WebWorkspaceState {
    const group = this.tabGroup(owner, id);
    if (group.tabs.length >= WEB_WORKSPACE_TAB_LIMIT) throw new Error(`A website can have up to ${WEB_WORKSPACE_TAB_LIMIT} tabs. Close a tab before opening another.`);
    const tab: WorkspaceTab = { id: randomUUID(), url: url === undefined ? "about:blank" : websiteURL(url), title: "", zoomFactor: 1 };
    group.tabs.push(tab);
    this.activate(group, tab);
    this.emit(group);
    return this.state(group);
  }

  selectTab(owner: BrowserWindow, id: string, tabId: string): WebWorkspaceState {
    const group = this.tabGroup(owner, id);
    const tab = group.tabs.find(candidate => candidate.id === tabId);
    if (!tab) throw new Error("The website tab is no longer open.");
    this.activate(group, tab);
    this.emit(group);
    return this.state(group);
  }

  async closeTab(owner: BrowserWindow, id: string, tabId: string): Promise<WebWorkspaceState> {
    const group = this.tabGroup(owner, id);
    const index = group.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) throw new Error("The website tab is no longer open.");
    const page = group.tabs[index].page;
    page?.automation?.reclaim();
    if (!page || page.contents.isDestroyed()) this.removeTab(group, index);
    else {
      if (!page.pendingClose) {
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        page.pendingClose = { promise, resolve };
        // Keep the tab and its reopen entry unchanged until Chromium accepts
        // the close. A site's beforeunload can still let the user stay.
        page.contents.close({ waitForBeforeUnload: true });
      }
      await page.pendingClose?.promise;
    }
    if (this.groups.get(id) !== group) throw new Error("The website is no longer open.");
    return this.state(group);
  }

  reopenTab(owner: BrowserWindow, id: string): WebWorkspaceState {
    const group = this.tabGroup(owner, id);
    if (group.tabs.length >= WEB_WORKSPACE_TAB_LIMIT) throw new Error(`Close a tab before restoring another. The limit is ${WEB_WORKSPACE_TAB_LIMIT} tabs per website.`);
    const closed = group.closedTabs.pop();
    if (closed) {
      const tab: WorkspaceTab = { ...closed, id: randomUUID() };
      group.tabs.push(tab);
      this.activate(group, tab);
      this.emit(group);
    }
    return this.state(group);
  }

  find(owner: BrowserWindow, id: string, text: string, options: WebWorkspaceFindOptions = {}): WebWorkspaceState {
    const group = this.group(owner, id);
    if (typeof text !== "string" || text.length > 10_000) throw new Error("The search text is too long.");
    if (!text) return this.stopFind(owner, id);
    const page = this.ensurePage(group, this.activeTab(group));
    // Electron calls Chromium new_session "findNext": true starts a search,
    // while our public flag means advance an existing search result.
    const requestId = page.contents.findInPage(text, { forward: options.forward !== false, findNext: options.findNext !== true });
    page.findRequestId = requestId;
    page.findResult = { requestId, activeMatchOrdinal: 0, matches: 0, finalUpdate: false };
    this.emit(group);
    return this.state(group);
  }

  stopFind(owner: BrowserWindow, id: string): WebWorkspaceState {
    const group = this.group(owner, id);
    this.clearFind(this.activeTab(group).page);
    this.emit(group);
    return this.state(group);
  }

  setZoom(owner: BrowserWindow, id: string, factor: number): WebWorkspaceState {
    const group = this.group(owner, id);
    if (!Number.isFinite(factor) || factor < WEB_WORKSPACE_ZOOM_MIN || factor > WEB_WORKSPACE_ZOOM_MAX) throw new Error("Website zoom must be between 25% and 300%.");
    const tab = this.activeTab(group);
    tab.page?.automation?.reclaim();
    tab.zoomFactor = factor;
    this.ensurePage(group, tab).contents.setZoomFactor(factor);
    this.emit(group);
    return this.state(group);
  }

  close(owner: BrowserWindow, id: string): void {
    const group = this.groups.get(id);
    // Explicit removal also forgets destinations not opened since startup.
    if (!group) { this.options.library?.removeSession(id); return; }
    if (group.owner !== owner) throw new Error("This website belongs to another window.");
    if (group.tabbed) this.options.library?.removeSession(id);
    this.destroyGroup(group);
  }

  destroyAll(): void {
    for (const group of [...this.groups.values()]) this.destroyGroup(group);
    this.flushLibrary();
    this.options.downloads?.destroyAll();
  }

  private automationRestricted(page: WorkspacePage): boolean {
    return Boolean(page.automation || page.inheritedAutomation?.some(lease => lease.active));
  }

  handleDownload(contents: WebContents, item: DownloadItem): void {
    const owned = this.contentsOwners.get(contents.id);
    if (owned && !this.automationRestricted(owned.page) && this.options.downloads) this.options.downloads.start(owned.page.owner, owned.page.group.id, item);
    else item.cancel();
  }
  ownsWebContents(id: number): boolean {
    return this.contentsOwners.has(id);
  }

  checkPermission(contents: WebContents, permission: string, requestingOrigin: string): boolean {
    const origin = requestOrigin(requestingOrigin);
    const topOrigin = requestOrigin(contents.getURL());
    const owned = this.contentsOwners.get(contents.id);
    return Boolean(origin && topOrigin && owned && !this.automationRestricted(owned.page) && TAB_PERMISSIONS.has(permission)
      && owned.grants.has(`${topOrigin}\n${origin}\n${permission}`));
  }

  requestPermission(
    contents: WebContents,
    permission: string,
    callback: (allowed: boolean) => void,
    details: BrowserPermissionRequestDetails,
  ): void {
    const owned = this.contentsOwners.get(contents.id);
    const origin = requestOrigin(details.requestingUrl);
    if (!owned || this.automationRestricted(owned.page) || !origin || permission === "notifications" || contents.isDestroyed() || this.permissionPrompts.has(contents.id)) {
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
    const navigationGeneration = owned.navigationGeneration;
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
      const allowed = response === 1 && !this.automationRestricted(owned.page) && !contents.isDestroyed()
        && this.contentsOwners.get(contents.id) === owned && owned.navigationGeneration === navigationGeneration
        && requestOrigin(contents.getURL()) === pageOrigin;
      if (allowed && TAB_PERMISSIONS.has(permission)) owned.grants.add(`${pageOrigin}\n${origin}\n${permission}`);
      callback(allowed);
    }, () => callback(false)).finally(() => { this.permissionPrompts.delete(contents.id); });
  }

  private group(owner: BrowserWindow, id: string): WorkspaceGroup {
    const group = this.groups.get(id);
    if (!group || group.owner !== owner) throw new Error("The website is no longer open.");
    return group;
  }

  private tabGroup(owner: BrowserWindow, id: string): WorkspaceGroup {
    const group = this.group(owner, id);
    if (!group.tabbed) throw new Error("This website does not support tab groups.");
    return group;
  }

  private activeTab(group: WorkspaceGroup): WorkspaceTab {
    return group.tabs.find(tab => tab.id === group.activeTabId)!;
  }

  private tabState(tab: WorkspaceTab): WebWorkspaceTabState {
    const page = tab.page;
    const contents = page && !page.contents.isDestroyed() ? page.contents : undefined;
    return {
      id: tab.id, url: page?.error || contents?.isLoading() ? page!.requestedURL : contents?.getURL() || tab.url,
      title: contents?.getTitle() || tab.title, loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      zoomFactor: tab.zoomFactor,
      ...(page?.automation ? { agentControlled: true } : {}),
      ...(page?.findResult ? { findResult: page.findResult } : {}),
      ...(page?.error ? { error: page.error } : {}),
    };
  }

  private state(group: WorkspaceGroup): WebWorkspaceState {
    return {
      ...this.tabState(this.activeTab(group)), id: group.id,
      ...(group.tabbed ? { tabs: group.tabs.map(tab => this.tabState(tab)), activeTabId: group.activeTabId, canReopenTab: group.closedTabs.length > 0 } : {}),
    };
  }

  private emit(group: WorkspaceGroup): void {
    if (this.groups.get(group.id) !== group || group.owner.isDestroyed()) return;
    if (group.tabbed) this.options.library?.saveSession(group.id, {
      homeURL: group.homeURL,
      tabs: group.tabs.map(tab => { const state = this.tabState(tab); return { id: state.id, url: state.url, title: state.title }; }),
      activeTabId: group.activeTabId,
    });
    this.onState(group.owner, this.state(group));
  }

  private ensurePage(group: WorkspaceGroup, tab: WorkspaceTab): WorkspacePage {
    if (tab.page && !tab.page.contents.isDestroyed()) return tab.page;
    const page = this.attachPage(group, tab, createBrowserView());
    this.navigate(page, tab.url);
    return page;
  }

  private attachPage(group: WorkspaceGroup, tab: WorkspaceTab, view: WebContentsView, inheritedAutomation?: readonly AutomationRestriction[]): WorkspacePage {
    const page: WorkspacePage = {
      id: randomUUID(), group, tab, owner: group.owner, view, contents: view.webContents,
      bounds: null, requestedURL: tab.url, navigationGeneration: 0, popups: new Set(), inheritedAutomation,
    };
    tab.page = page;
    this.pages.set(page.id, page);
    view.setVisible(false);
    group.owner.contentView.addChildView(view);
    this.secureContents(page, page.contents);
    page.contents.on("before-input-event", (event, input) => this.handleInput(page, event, input));
    page.contents.on("enter-html-full-screen", () => {
      page.htmlFullscreen = true;
      // HTML fullscreen belongs to this native page, not the shell's ribbon
      // viewport. Restore its focus after the permission dialog so Chromium
      // receives the user's Escape key and handles fullscreen exit itself.
      group.owner.contentView.addChildView(view);
      this.layout(page);
      if (view.getVisible()) page.contents.focus();
    });
    page.contents.on("leave-html-full-screen", () => {
      page.htmlFullscreen = false;
      this.layout(page);
      if (!page.contents.isDestroyed() && page.bounds && view.getVisible()) page.contents.focus();
    });
    page.contents.on("did-start-loading", () => { page.error = undefined; this.emit(group); });
    page.contents.on("did-stop-loading", () => this.emit(group));
    page.contents.on("did-start-navigation", details => {
      if (!details.isMainFrame) return;
      page.navigationGeneration++;
      page.requestedURL = details.url;
      if (!details.isSameDocument) this.clearFind(page);
    });
    const committed = (_event: Electron.Event, url: string) => {
      page.error = undefined;
      page.requestedURL = url;
      tab.url = url;
      tab.title = page.contents.getTitle();
      // Chromium's origin zoom is shared; reapply this tab's chosen factor when
      // it navigates or becomes active, keeping the shell's zoom independent.
      if (page.bounds) page.contents.setZoomFactor(tab.zoomFactor);
      if (group.tabbed) {
        this.options.library?.recordVisit({ url, title: tab.title });
        this.options.onLibraryChange?.(group.owner);
      }
      this.emit(group);
    };
    page.contents.on("did-navigate", committed);
    page.contents.on("did-navigate-in-page", (event, url, isMainFrame) => { if (isMainFrame) committed(event, url); });
    page.contents.on("page-title-updated", () => {
      tab.title = page.contents.getTitle();
      if (group.tabbed) {
        this.options.library?.updateTitle(tab.url, tab.title);
        this.options.onLibraryChange?.(group.owner);
      }
      this.emit(group);
    });
    page.contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || (url && url !== page.requestedURL)) return;
      page.error = description || "The website could not be loaded.";
      this.emit(group);
    });
    page.contents.on("render-process-gone", () => {
      page.error = "The website stopped responding. Reload to try again.";
      this.emit(group);
    });
    page.contents.on("found-in-page", (_event, result) => {
      if (page.findRequestId !== result.requestId) return;
      page.findResult = { requestId: result.requestId, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches, finalUpdate: result.finalUpdate };
      this.emit(group);
    });
    page.contents.on("zoom-changed", (_event, direction) => this.stepZoom(page, direction === "in" ? 1 : -1));
    page.contents.on("context-menu", (_event, params) => this.contextMenu(page, params));
    page.contents.once("destroyed", () => {
      if (this.pages.get(page.id) !== page || this.groups.get(group.id) !== group) return;
      const index = group.tabs.indexOf(tab);
      if (group.tabbed && index >= 0) this.removeTab(group, index);
      else {
        this.destroyPage(page);
        page.error = "The website closed this page. Reopen it to continue.";
        if (!group.owner.isDestroyed()) this.onState(group.owner, { id: group.id, url: tab.url, title: tab.title, loading: false, canGoBack: false, canGoForward: false, error: page.error });
        this.groups.delete(group.id);
      }
    });
    this.layoutGroup(group);
    return page;
  }

  private activate(group: WorkspaceGroup, tab: WorkspaceTab): void {
    if (group.activeTabId !== tab.id) this.clearFind(this.activeTab(group).page);
    group.activeTabId = tab.id;
    this.ensurePage(group, tab).contents.setZoomFactor(tab.zoomFactor);
    this.layoutGroup(group);
  }

  private removeTab(group: WorkspaceGroup, index: number): void {
    const tab = group.tabs[index];
    const state = this.tabState(tab);
    group.closedTabs.push({ url: state.url, title: state.title, zoomFactor: tab.zoomFactor });
    if (group.closedTabs.length > 20) group.closedTabs.shift();
    group.tabs.splice(index, 1);
    if (tab.page) this.destroyPage(tab.page);
    if (!group.tabs.length) group.tabs.push({ id: randomUUID(), url: "about:blank", title: "", zoomFactor: 1 });
    if (group.activeTabId === tab.id) {
      group.activeTabId = group.tabs[Math.min(index, group.tabs.length - 1)].id;
      this.activate(group, this.activeTab(group));
    }
    this.emit(group);
  }

  private clearFind(page?: WorkspacePage): void {
    if (!page || page.contents.isDestroyed()) return;
    page.contents.stopFindInPage("clearSelection");
    page.findRequestId = undefined;
    page.findResult = undefined;
  }

  private navigate(page: WorkspacePage, url: string): void {
    page.automation?.reclaim();
    page.error = undefined;
    page.requestedURL = url;
    const generation = ++page.navigationGeneration;
    void page.contents.loadURL(url).catch((error: Error & { code?: string }) => {
      if (error.code === "ERR_ABORTED" || this.pages.get(page.id) !== page || page.navigationGeneration > generation + 1) return;
      page.error = error.message;
      this.emit(page.group);
    });
  }

  private destroyPage(page: WorkspacePage): void {
    page.automation?.reclaim();
    this.pages.delete(page.id);
    page.tab.page = undefined;
    for (const popup of page.popups) if (!popup.isDestroyed()) popup.destroy();
    if (!page.owner.isDestroyed()) page.owner.contentView.removeChildView(page.view);
    if (!page.contents.isDestroyed()) page.contents.close();
    page.pendingClose?.resolve();
    page.pendingClose = undefined;
  }

  private flushLibrary(): void {
    try { this.options.library?.flush(); } catch (error) { console.warn("[web-workspace] Could not save browser session", error); }
  }

  private destroyGroup(group: WorkspaceGroup): void {
    this.groups.delete(group.id);
    if (this.shortcutTargets.get(group.owner.webContents.id) === group.id) this.shortcutTargets.delete(group.owner.webContents.id);
    for (const tab of group.tabs) if (tab.page) this.destroyPage(tab.page);
  }

  private layoutGroup(group: WorkspaceGroup): void {
    for (const tab of group.tabs) {
      if (!tab.page) continue;
      const bounds = tab.id === group.activeTabId ? group.bounds : null;
      // Inactive pages have already been hidden. Resizing their owner must not
      // wake them or disturb a view borrowed by an observation window.
      if (!bounds && !tab.page.bounds) continue;
      tab.page.bounds = bounds;
      tab.page.automation?.layout();
      this.layout(tab.page);
    }
  }

  private layout(page: WorkspacePage): void {
    const { owner, view } = page;
    if (owner.isDestroyed() || page.contents.isDestroyed() || page.automation?.external) return;
    if (!page.bounds || owner.isMinimized() || !owner.isVisible()) {
      if (page.contents.isFocused()) owner.webContents.focus();
      if (view.getVisible()) view.setVisible(false);
      return;
    }
    // Renderer bounds and native resize events can report the same geometry.
    // Chromium converts zoom through logarithmic levels, so compare with a
    // tolerance instead of reapplying it for floating-point round-off.
    if (Math.abs(page.contents.getZoomFactor() - page.tab.zoomFactor) > 1e-6) page.contents.setZoomFactor(page.tab.zoomFactor);
    const [width, height] = owner.getContentSize();
    const htmlFullscreen = page.htmlFullscreen && page.group.activeTabId === page.tab.id;
    const bounds = htmlFullscreen ? { x: 0, y: 0, width, height } : page.bounds;
    const zoom = htmlFullscreen ? 1 : owner.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
    const right = Math.max(x, Math.min(width, Math.round((bounds.x + bounds.width) * zoom)));
    const bottom = Math.max(y, Math.min(height, Math.round((bounds.y + bounds.height) * zoom)));
    const current = view.getBounds();
    if (current.x !== x || current.y !== y || current.width !== right - x || current.height !== bottom - y) {
      view.setBounds({ x, y, width: right - x, height: bottom - y });
    }
    const visible = right > x && bottom > y;
    if (view.getVisible() !== visible) {
      view.setVisible(visible);
      if (visible && htmlFullscreen) page.contents.focus();
    }
  }

  private observeOwner(owner: BrowserWindow): void {
    const id = owner.webContents.id;
    if (this.observedOwners.has(id)) return;
    this.observedOwners.add(id);
    const layout = () => { for (const group of this.groups.values()) if (group.owner === owner) this.layoutGroup(group); };
    const closePages = () => {
      // Renderer recovery releases all native resources but keeps the safe
      // session metadata. Destinations restore lazily with the same profile.
      for (const group of [...this.groups.values()]) if (group.owner === owner) this.destroyGroup(group);
      this.flushLibrary();
    };
    owner.on("resize", layout);
    owner.on("show", layout);
    owner.on("hide", layout);
    owner.on("minimize", layout);
    owner.on("restore", layout);
    owner.on("enter-full-screen", () => {
      layout();
      // macOS completes its native transition asynchronously, after the HTML
      // event. Reassert the requesting page's focus once that transition ends.
      for (const page of this.pages.values()) {
        if (page.owner === owner && page.htmlFullscreen && !page.contents.isDestroyed() && page.view.getVisible()) page.contents.focus();
      }
    });
    owner.on("leave-full-screen", layout);
    owner.webContents.on("did-start-navigation", details => { if (details.isMainFrame && !details.isSameDocument) closePages(); });
    owner.webContents.on("render-process-gone", closePages);
    owner.once("closed", () => { closePages(); this.observedOwners.delete(id); });
  }

  private handleInput(page: WorkspacePage, event: Electron.Event, input: Electron.Input): void {
    if (page.automation?.agentInput()) return;
    if (input.type !== "keyDown" || input.alt || !page.bounds) return;
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    const group = page.group;
    if (key === "tab" && input.control && group.tabbed) {
      event.preventDefault();
      const index = group.tabs.findIndex(tab => tab.id === group.activeTabId);
      this.selectTab(page.owner, group.id, group.tabs[(index + (input.shift ? -1 : 1) + group.tabs.length) % group.tabs.length].id);
      this.activeTab(group).page?.contents.focus();
      return;
    }
    if (key === "f5") {
      event.preventDefault();
      this.command(page.owner, group.id, input.shift ? "reloadIgnoringCache" : "reload");
      return;
    }
    if (!modifier) return;
    if (group.tabbed && !input.shift && /^[1-9]$/.test(key)) {
      event.preventDefault();
      const tab = group.tabs[key === "9" ? group.tabs.length - 1 : Number(key) - 1];
      if (tab) { this.selectTab(page.owner, group.id, tab.id); tab.page?.contents.focus(); }
      return;
    }
    if (key === "l" || key === "f") {
      event.preventDefault();
      page.owner.webContents.focus();
      if (key === "l") this.onFocusAddress(page.owner, group.id); else this.options.onFocusFind?.(page.owner, group.id);
    } else if (key === "r") {
      event.preventDefault();
      this.command(page.owner, group.id, input.shift ? "reloadIgnoringCache" : "reload");
    } else if (key === "t" && group.tabbed) {
      event.preventDefault();
      if (group.tabs.length >= WEB_WORKSPACE_TAB_LIMIT) return;
      if (input.shift) this.reopenTab(page.owner, group.id); else this.createTab(page.owner, group.id);
      page.owner.webContents.focus();
      this.onFocusAddress(page.owner, group.id);
    } else if (key === "w" && !input.shift && group.tabbed) {
      event.preventDefault();
      void this.closeTab(page.owner, group.id, group.activeTabId).then(() => {
        this.activeTab(group).page?.contents.focus();
      }).catch(error => console.warn("[web-workspace] Could not close tab", error));
    } else if (key === "+" || key === "=" || key === "-" || key === "0") {
      event.preventDefault();
      if (key === "0") this.setZoom(page.owner, group.id, 1); else this.stepZoom(page, key === "-" ? -1 : 1);
    }
  }

  private stepZoom(page: WorkspacePage, direction: number): void {
    const current = page.tab.zoomFactor;
    const next = direction > 0 ? ZOOM_LEVELS.find(level => level > current + 0.001) : [...ZOOM_LEVELS].reverse().find(level => level < current - 0.001);
    if (next) this.setZoom(page.owner, page.group.id, next);
  }

  private contextMenu(page: WorkspacePage, params: Electron.ContextMenuParams): void {
    const template: Electron.MenuItemConstructorOptions[] = [];
    let link: string | undefined;
    try { if (params.linkURL) link = websiteURL(params.linkURL); } catch { /* Internal and executable URLs are not browser destinations. */ }
    if (link) {
      const url = link;
      if (page.group.tabbed) template.push({ label: "Open Link in New Tab", enabled: page.group.tabs.length < WEB_WORKSPACE_TAB_LIMIT, click: () => this.createTab(page.owner, page.group.id, url) });
      template.push({ label: "Copy Link Address", click: () => clipboard.writeText(url) }, { type: "separator" });
    }
    if (params.isEditable) template.push({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    else if (params.selectionText) template.push({ role: "copy" }, { role: "selectAll" });
    else template.push(
      { label: "Back", enabled: page.contents.navigationHistory.canGoBack(), click: () => this.command(page.owner, page.group.id, "back") },
      { label: "Forward", enabled: page.contents.navigationHistory.canGoForward(), click: () => this.command(page.owner, page.group.id, "forward") },
      { label: "Reload", click: () => this.command(page.owner, page.group.id, "reload") },
    );
    Menu.buildFromTemplate(template).popup({ window: page.owner });
  }

  private secureContents(page: WorkspacePage, contents: WebContents): void {
    const contentsID = contents.id;
    const owned: PermissionOwner = { page, grants: new Set(), navigationGeneration: 0 };
    this.contentsOwners.set(contentsID, owned);
    contents.once("destroyed", () => this.contentsOwners.delete(contentsID));
    contents.on("did-start-navigation", details => { if (details.isMainFrame && !details.isSameDocument) owned.navigationGeneration++; });
    contents.on("will-attach-webview", event => event.preventDefault());
    contents.on("will-prevent-unload", event => {
      const parent = BrowserWindow.fromWebContents(contents) ?? page.owner;
      // The native dialog identifies the origin, rather than trusting site
      // wording. Stay is the safe default for unsaved forms and editors.
      const response = parent.isDestroyed() || !parent.isVisible() || parent.isMinimized() ? 0 : dialog.showMessageBoxSync(parent, {
        type: "question", title: "Leave this website?",
        message: `${requestOrigin(contents.getURL()) ?? "This website"} may have unsaved changes.`,
        detail: "Leaving or closing this page may discard changes you have made.",
        buttons: ["Stay", "Leave"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response === 1) event.preventDefault();
      else if (contents === page.contents) {
        page.requestedURL = contents.getURL() || page.tab.url;
        page.error = undefined;
        page.navigationGeneration++;
        page.pendingClose?.resolve();
        page.pendingClose = undefined;
        this.emit(page.group);
      }
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      try { websiteURL(url); } catch { event.preventDefault(); void this.openExternal(page, contents, url); }
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    contents.setWindowOpenHandler(details => {
      const parent = BrowserWindow.fromWebContents(contents) ?? page.owner;
      const restricted = this.automationRestricted(page);
      if (parent.isDestroyed() || (!restricted && (!parent.isVisible() || parent.isMinimized() || (contents === page.contents && !page.bounds)))) return { action: "deny" };
      const target = details.url || "about:blank";
      if (target !== "about:blank") {
        try { websiteURL(target); } catch { void this.openExternal(page, contents, target); return { action: "deny" }; }
      }
      const popup = target === "about:blank" || !page.group.tabbed || page.group.tabs.length >= WEB_WORKSPACE_TAB_LIMIT || contents !== page.contents || details.disposition === "new-window"
        || details.features.split(",").some(feature => /^(popup|width|height|left|top)\s*(=|$)/i.test(feature.trim()));
      const response: Electron.WindowOpenHandlerResponse = {
        action: "allow", outlivesOpener: !popup,
        overrideBrowserWindowOptions: {
          parent: page.owner, width: 1000, height: 750, autoHideMenuBar: true,
          ...(restricted ? { show: false } : {}),
          frame: true, alwaysOnTop: false, fullscreen: false,
          webPreferences: {
            partition: BROWSER_PARTITION, preload: "", contextIsolation: true,
            nodeIntegration: false, nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false, sandbox: true, webviewTag: false,
            webSecurity: true, allowRunningInsecureContent: false,
          },
        },
      };
      if (!popup) response.createWindow = options => {
        const view = createBrowserView(options);
        if (this.pages.get(page.id) !== page || this.groups.get(page.group.id) !== page.group) {
          view.webContents.close();
          return view.webContents;
        }
        const tab: WorkspaceTab = { id: randomUUID(), url: target, title: "", zoomFactor: 1 };
        page.group.tabs.push(tab);
        // A child keeps user ownership, but cannot escape its opener's live
        // agent restrictions. Tokens expire independently; a later attachment
        // of this child retains its own restriction until that lease releases.
        const restrictions = [...(page.inheritedAutomation ?? []), ...(page.automation ? [page.automation.restriction] : [])].filter(lease => lease.active);
        const child = this.attachPage(page.group, tab, view, restrictions);
        // Keep Chromium's WindowProxy/opener, original POST, and referrer. A
        // supplied guest is already navigating; never load it a second time.
        if (!(options as WebContentsViewConstructorOptions).webContents) {
          const post = details.postBody;
          const headers = post ? `Content-Type: ${post.contentType}${post.boundary ? `; boundary=${post.boundary}` : ""}` : undefined;
          void view.webContents.loadURL(target, { httpReferrer: details.referrer, postData: post?.data, extraHeaders: headers }).catch(error => {
            if (error.code !== "ERR_ABORTED" && this.pages.has(child.id)) { child.error = error.message; this.emit(page.group); }
          });
        }
        if (!restricted && details.disposition !== "background-tab") this.activate(page.group, tab);
        this.emit(page.group);
        return view.webContents;
      };
      return response;
    });
    contents.on("did-create-window", popup => {
      page.popups.add(popup);
      this.secureContents(page, popup.webContents);
      const showOrigin = () => popup.setTitle(`Website: ${requestOrigin(popup.webContents.getURL()) ?? requestOrigin(contents.getURL()) ?? "New window"}`);
      popup.webContents.on("did-navigate", showOrigin);
      popup.webContents.on("page-title-updated", event => { event.preventDefault(); showOrigin(); });
      showOrigin();
      popup.once("closed", () => page.popups.delete(popup));
    });
  }
  private async openExternal(page: WorkspacePage, contents: WebContents, value: string): Promise<void> {
    if (this.automationRestricted(page)) return;
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
      if (response === 1 && !this.automationRestricted(page) && !contents.isDestroyed() && this.pages.get(page.id) === page
        && requestOrigin(contents.getURL()) === origin) await shell.openExternal(value);
    } catch (error) {
      console.warn("[web-workspace] Could not open external link", error);
    } finally {
      this.externalPrompts.delete(contents.id);
    }
  }
}
