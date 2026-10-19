import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { WEB_WORKSPACE_ZOOM_MIN, WEB_WORKSPACE_ZOOM_MAX, WEB_WORKSPACE_TAB_LIMIT, type WebWorkspaceApi, type WebWorkspaceCommand, type WebWorkspaceState } from "../shared/webWorkspace";
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, ChevronUp, Ellipsis, Globe, Minus, Plus, RotateCcw, RotateCw, Search, X } from "./WuuIcons";
import { useI18n } from "./i18n";
import { normalizeWebsiteURL } from "./NavigationRibbonPreferences";
import { rawErrorMessage } from "./UserFacingErrors";
import { showActionErrorToast } from "./Toast";
import { WebWorkspaceDownloadsMenu } from "./WebWorkspaceDownloadsMenu";
import { BrowserLibrary } from "./BrowserLibrary";
import { composerMenuWidth, FloatingMenuPortal, handleFloatingMenuKeyDown, menuOpeningKey, useFloatingMenuFocus } from "./ComposerFloatingMenu";
import "./styles/web-workspace.css";

export interface WebWorkspaceSite {
  id: string;
  url: string;
  title?: string;
}

/** Shared browser surface for user destinations and extension-provided pages. */
export function WebWorkspacePanel({
  site,
  active = true,
  tabs = false,
}: {
  site?: WebWorkspaceSite;
  active?: boolean;
  tabs?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const api = (window.wuu as typeof window.wuu & { webWorkspace?: WebWorkspaceApi }).webWorkspace;
  const panelRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<WebWorkspaceState>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const addressEdited = useRef(false);
  const lastAddressPage = useRef("");
  const instanceID = useId();
  const addressErrorID = `${instanceID}-address-error`;
  const currentSiteID = useRef(site?.id);
  currentSiteID.current = site?.id;
  const current = page?.id === site?.id ? page : undefined;
  const error = failure && failure.id === site?.id ? failure.message : current?.error;
  const currentURL = current?.url || site?.url || "";
  const blank = currentURL === "about:blank";
  const zoomFactor = current?.zoomFactor ?? 1;
  const pageTabs = current?.tabs ?? [];
  const hasCurrent = Boolean(current);

  const focusAddress = useCallback(() => {
    setMenuOpen(false);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const update = useCallback(async (operation: (browser: WebWorkspaceApi, id: string) => Promise<WebWorkspaceState>): Promise<WebWorkspaceState | undefined> => {
    if (!api || !site) return;
    const { id } = site;
    setFailure(undefined);
    try {
      const next = await operation(api, id);
      if (currentSiteID.current === id) setPage(next);
      return next;
    } catch (cause) {
      if (currentSiteID.current === id) {
        if (hasCurrent) showActionErrorToast(rawErrorMessage(cause));
        else setFailure({ id, message: rawErrorMessage(cause) });
      }
    }
  }, [api, site?.id, hasCurrent]);

  useEffect(() => {
    if (!api) return;
    return api.onState((next) => {
      if (next.id !== currentSiteID.current) return;
      setPage(next);
    });
  }, [api]);

  useEffect(() => {
    if (!api || !active) return;
    const visible = (id: string): boolean => id === currentSiteID.current && Boolean(hostRef.current && visibleElementRect(hostRef.current));
    const offAddress = api.onFocusAddress((id) => { if (visible(id)) focusAddress(); });
    const offFind = api.onFocusFind((id) => {
      if (!visible(id)) return;
      setMenuOpen(false);
      setFindOpen(true);
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
    return () => { offAddress(); offFind(); };
  }, [api, active, focusAddress]);

  useEffect(() => {
    if (!api || !site || !active) return;
    let disposed = false;
    const { id, url } = site;
    setFailure(undefined);
    void api.open({ id, url, tabs }).then((next) => {
      if (!disposed) setPage(next);
    }).catch((cause: unknown) => {
      if (!disposed) setFailure({ id, message: rawErrorMessage(cause) });
    });
    return () => { disposed = true; };
  }, [api, site?.id, site?.url, active, tabs]);

  useEffect(() => {
    const addressPage = `${site?.id}/${current?.activeTabId ?? ""}`;
    const changedPage = lastAddressPage.current !== addressPage;
    lastAddressPage.current = addressPage;
    // Redirects must not replace a new address while the user is typing it.
    if (!changedPage && addressEdited.current && document.activeElement === inputRef.current) return;
    addressEdited.current = false;
    setAddress(blank ? "" : currentURL);
    setAddressError("");
  }, [currentURL, site?.id, current?.activeTabId, blank]);

  useEffect(() => {
    setMenuOpen(false);
    setFindOpen(false);
    setFindText("");
  }, [site?.id, current?.activeTabId, active]);

  useLayoutEffect(() => {
    if (findOpen) { findInputRef.current?.focus(); findInputRef.current?.select(); }
  }, [findOpen]);

  useEffect(() => {
    const selected = tabListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current?.activeTabId]);

  const run = useCallback(async (action: WebWorkspaceCommand, url?: string): Promise<void> => {
    await update(async (browser, id) => {
      // A failed initial creation remains retryable through the address bar.
      if (!current || action === "reload" || action === "reloadIgnoringCache") await browser.open({ id, url: site!.url, tabs });
      return browser.command(id, action, url);
    });
  }, [update, current, site?.url, tabs]);

  const addTab = useCallback(async (): Promise<void> => {
    const id = site?.id;
    const next = await update((browser, destination) => browser.createTab(destination));
    if (next && currentSiteID.current === id) focusAddress();
  }, [update, site?.id, focusAddress]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindText("");
    void update(async (browser, id) => { await browser.stopFind(id); return browser.command(id, "focus"); });
  }, [update]);

  const find = useCallback((text: string, forward = true, findNext = false) => {
    void update((browser, id) => text ? browser.find(id, text, { forward, findNext }) : browser.stopFind(id));
  }, [update]);

  const openFind = useCallback(() => {
    setMenuOpen(false);
    setFindOpen(true);
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  const changeZoom = useCallback((factor: number) => {
    void update((browser, id) => browser.setZoom(id, Math.max(WEB_WORKSPACE_ZOOM_MIN, Math.min(WEB_WORKSPACE_ZOOM_MAX, Math.round(factor * 100) / 100))));
  }, [update]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const id = site?.id;
    if (!api || !id || !host || !current) return;
    if (!active || error || blank) {
      void api.reportBounds(id, null).catch(() => undefined);
      return;
    }
    return observeWebWorkspaceBounds(host, (bounds) => {
      void api.reportBounds(id, bounds).catch((cause: unknown) => {
        if (currentSiteID.current === id) setFailure({ id, message: rawErrorMessage(cause) });
      });
    });
  }, [api, site?.id, active, Boolean(current), current?.activeTabId, error, blank]);

  useEffect(() => {
    if (!api || !site) return;
    const id = site.id;
    let last: boolean | undefined;
    const report = (): void => {
      const panel = panelRef.current;
      const target = focusedWebWorkspacePanel();
      const modal = [...document.querySelectorAll(MODALS)].some((layer) => !layer.contains(panel) && visibleElementRect(layer));
      const selected = Boolean(active && panel && visibleElementRect(panel) && target === panel && !modal);
      if (last === selected) return;
      last = selected;
      void api.setShortcutTarget(id, selected).catch(() => undefined);
    };
    const mutation = new MutationObserver(report);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "inert", "class", "style", "open", "aria-modal"] });
    document.addEventListener("focusin", report);
    window.addEventListener("resize", report);
    report();
    return () => {
      mutation.disconnect();
      document.removeEventListener("focusin", report);
      window.removeEventListener("resize", report);
      void api.setShortcutTarget(id, false).catch(() => undefined);
    };
  }, [api, site?.id, active]);

  useEffect(() => {
    if (!active || !site) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.defaultPrevented) return;
      // Retained plugin pages may be inert behind another page. Only the visible
      // focused browser surface owns browser shortcuts.
      if (!hostRef.current || !visibleElementRect(hostRef.current)) return;
      const target = focusedWebWorkspacePanel();
      if (target !== panelRef.current) return;
      const key = event.key.toLowerCase();
      let action: (() => void) | undefined;
      if (key === "l") action = focusAddress;
      else if (key === "f") action = openFind;
      else if (key === "r") action = () => { void run(event.shiftKey ? "reloadIgnoringCache" : "reload"); };
      else if (key === "0") action = () => changeZoom(1);
      else if (key === "=" || key === "+") action = () => changeZoom(zoomFactor + 0.1);
      else if (key === "-") action = () => changeZoom(zoomFactor - 0.1);
      else if (tabs && key === "t") action = () => { if (pageTabs.length >= WEB_WORKSPACE_TAB_LIMIT) return; if (event.shiftKey) void update((browser, id) => browser.reopenTab(id)); else void addTab(); };
      else if (tabs && key === "w" && current?.activeTabId) action = () => { void update((browser, id) => browser.closeTab(id, current.activeTabId!)); };
      else if (tabs && pageTabs.length && (key === "tab" || /^[1-9]$/.test(key))) {
        const position = pageTabs.findIndex((tab) => tab.id === current?.activeTabId);
        const index = key === "tab" ? (position + (event.shiftKey ? -1 : 1) + pageTabs.length) % pageTabs.length : key === "9" ? pageTabs.length - 1 : Number(key) - 1;
        if (pageTabs[index]) action = () => { void update((browser, id) => browser.selectTab(id, pageTabs[index].id)); };
      }
      if (action) { event.preventDefault(); event.stopImmediatePropagation(); action(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, site?.id, tabs, current?.activeTabId, pageTabs, focusAddress, openFind, run, update, addTab, changeZoom, zoomFactor]);

  useFloatingMenuFocus(menuRef, "browser-options", menuOpen && active);

  useEffect(() => {
    if (!menuOpen) return;
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !menuButtonRef.current?.contains(event.target)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", pointerDown);
    return () => window.removeEventListener("pointerdown", pointerDown);
  }, [menuOpen]);

  const submitAddress = (event: FormEvent): void => {
    event.preventDefault();
    const value = address.trim();
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^(?:localhost|[^\s/:]+\.[^\s/:]+|\[[\da-f:]+\]):\d+(?:[/#?]|$)/i.test(value);
    const isAddress = hasScheme || /^(?:localhost|\[[\da-f:]+\])(?:[:/\?#]|$)/i.test(value) || /^[^\s]+[./][^\s]*$/.test(value);
    const url = !value || /[\u0000-\u001f\u007f]/.test(value) ? null : isAddress ? normalizeWebsiteURL(value) : `https://www.google.com/search?q=${encodeURIComponent(value)}`;
    if (!url) { setAddressError(t("webWorkspace.invalidURL")); return; }
    addressEdited.current = false;
    setAddress(url);
    setAddressError("");
    inputRef.current?.blur();
    void run("navigate", url);
  };

  const openExternal = (): void => {
    const url = normalizeWebsiteURL(currentURL);
    setMenuOpen(false);
    if (url) void window.wuu.openExternal(url).catch((cause: unknown) => showActionErrorToast(rawErrorMessage(cause)));
  };

  return (
    <div ref={panelRef} className="web-workspace-panel" data-wuu-component="web-workspace" data-website-id={site?.id}>
      {tabs ? <div className="web-workspace-tabstrip">
        <div ref={tabListRef} className="web-workspace-tabs" role="tablist" aria-label={t("webWorkspace.tabs")}>
          {pageTabs.map((tab) => {
            const selected = tab.id === current?.activeTabId;
            const title = tab.url === "about:blank" ? t("webWorkspace.newTab") : tab.title || tab.url;
            return <div key={tab.id} className="web-workspace-tab" data-active={selected || undefined} data-tab-id={tab.id} onAuxClick={(event) => {
              if (event.button === 1) { event.preventDefault(); void update((browser, id) => browser.closeTab(id, tab.id)); }
            }}>
              <button type="button" className="web-workspace-tab-select" role="tab" id={`${instanceID}-tab-${tab.id}`} aria-selected={selected} aria-controls={`${instanceID}-page`} tabIndex={selected ? 0 : -1} title={title} onClick={() => void update((browser, id) => browser.selectTab(id, tab.id))} onKeyDown={(event) => {
                const index = pageTabs.findIndex((item) => item.id === tab.id);
                let next: number | undefined;
                if (event.key === "ArrowLeft") next = (index - 1 + pageTabs.length) % pageTabs.length;
                if (event.key === "ArrowRight") next = (index + 1) % pageTabs.length;
                if (event.key === "Home") next = 0;
                if (event.key === "End") next = pageTabs.length - 1;
                if (next !== undefined) {
                  event.preventDefault();
                  void update((browser, id) => browser.selectTab(id, pageTabs[next].id));
                  tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                } else if (event.key === "Delete") { event.preventDefault(); void update((browser, id) => browser.closeTab(id, tab.id)); }
              }}>
                {tab.loading ? <RotateCw className="icon web-workspace-tab-loading" aria-hidden="true" /> : <Globe className="icon" aria-hidden="true" />}
                <span>{title}</span>
              </button>
              <button type="button" className="icon-button web-workspace-tab-close" tabIndex={selected ? 0 : -1} aria-label={t("webWorkspace.closeTab", { title })} title={t("webWorkspace.closeTab", { title })} onClick={() => void update((browser, id) => browser.closeTab(id, tab.id))}><X className="icon" aria-hidden="true" /></button>
            </div>;
          })}
        </div>
        <button type="button" className="icon-button workspace-browser-nav web-workspace-new-tab" disabled={!api || !current || pageTabs.length >= WEB_WORKSPACE_TAB_LIMIT} aria-label={t("webWorkspace.newTab")} title={t("webWorkspace.newTab")} onClick={() => void addTab()}><Plus className="icon" aria-hidden="true" /></button>
      </div> : null}
      <div className="workspace-browser-toolbar web-workspace-toolbar" role="toolbar" aria-label={site?.title || t("webWorkspace.address")}>
        <div className="workspace-browser-nav-cluster">
          <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.back")} title={t("webWorkspace.back")} disabled={!api || !current?.canGoBack} onClick={() => void run("back")}><ArrowLeft className="icon" aria-hidden="true" /></button>
          <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.forward")} title={t("webWorkspace.forward")} disabled={!api || !current?.canGoForward} onClick={() => void run("forward")}><ArrowRight className="icon" aria-hidden="true" /></button>
          <button type="button" className="icon-button workspace-browser-nav" aria-label={t(current?.loading ? "webWorkspace.stop" : "webWorkspace.reload")} title={t(current?.loading ? "webWorkspace.stop" : "webWorkspace.reload")} disabled={!api || !site || blank} onClick={() => void run(current?.loading ? "stop" : "reload")}>{current?.loading ? <X className="icon" aria-hidden="true" /> : <RotateCw className="icon" aria-hidden="true" />}</button>
        </div>
        <form className="workspace-browser-url-form web-workspace-address" onSubmit={submitAddress}>
          <input ref={inputRef} className="workspace-browser-url-input" value={address} type="text" inputMode="url" spellCheck={false} autoCorrect="off" autoCapitalize="off" placeholder={t("webWorkspace.addressSearch")} aria-label={t("webWorkspace.address")} disabled={!site || !api} aria-invalid={Boolean(addressError)} aria-describedby={addressError ? addressErrorID : undefined} onChange={(event) => { addressEdited.current = true; setAddress(event.target.value); setAddressError(""); }} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => {
            if (event.key === "Escape") { addressEdited.current = false; setAddress(blank ? "" : currentURL); setAddressError(""); event.currentTarget.blur(); void run("focus"); }
          }} />
          {zoomFactor !== 1 ? <button type="button" className="web-workspace-zoom-badge" title={t("webWorkspace.resetZoom")} aria-label={t("webWorkspace.resetZoom")} onClick={() => changeZoom(1)}>{Math.round(zoomFactor * 100)}%</button> : null}
        </form>
        <div className="web-workspace-actions">
          <BrowserLibrary api={api} destinationId={site?.id} currentURL={currentURL} currentTitle={current?.title || site?.title || ""} onOpen={(url) => void run("navigate", url)} active={active} />
          <WebWorkspaceDownloadsMenu api={api} active={active} destinationId={site?.id} />
          <button ref={menuButtonRef} type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.options")} title={t("webWorkspace.options")} aria-expanded={menuOpen} aria-haspopup="dialog" disabled={!api || !site} onClick={() => setMenuOpen((open) => !open)} onKeyDown={(event) => { if (menuOpeningKey(event)) setMenuOpen(true); }}><Ellipsis className="icon" aria-hidden="true" /></button>
        </div>
        {menuOpen && active ? <FloatingMenuPortal anchorRef={menuButtonRef} owner="web-workspace-options" placement="below" align="right" width={composerMenuWidth(300)} flip><div ref={menuRef} className="web-workspace-menu" role="dialog" aria-label={t("webWorkspace.options")} data-wuu-layer="popover" data-web-workspace-owner={site?.id} onKeyDown={(event) => handleFloatingMenuKeyDown(event, () => setMenuOpen(false), menuButtonRef.current)} onBlur={(event) => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && !menuButtonRef.current?.contains(event.relatedTarget)) setMenuOpen(false);
        }}>
          <button type="button" className="web-workspace-menu-item" onClick={openFind}><Search className="icon" aria-hidden="true" /><span>{t("webWorkspace.find")}</span></button>
          <div className="web-workspace-menu-zoom" role="group" aria-label={t("webWorkspace.zoom")}>
            <span>{t("webWorkspace.zoom")}</span>
            <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.zoomOut")} disabled={zoomFactor <= WEB_WORKSPACE_ZOOM_MIN} onClick={() => changeZoom(zoomFactor - 0.1)}><Minus className="icon" aria-hidden="true" /></button>
            <button type="button" className="web-workspace-zoom-badge" title={t("webWorkspace.resetZoom")} aria-label={t("webWorkspace.resetZoom")} onClick={() => changeZoom(1)}>{Math.round(zoomFactor * 100)}%</button>
            <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.zoomIn")} disabled={zoomFactor >= WEB_WORKSPACE_ZOOM_MAX} onClick={() => changeZoom(zoomFactor + 0.1)}><Plus className="icon" aria-hidden="true" /></button>
          </div>
          {tabs ? <button type="button" className="web-workspace-menu-item" disabled={!current?.canReopenTab || pageTabs.length >= WEB_WORKSPACE_TAB_LIMIT} onClick={() => { setMenuOpen(false); void update((browser, id) => browser.reopenTab(id)); }}><RotateCcw className="icon" aria-hidden="true" /><span>{t("webWorkspace.reopenTab")}</span></button> : null}
          <button type="button" className="web-workspace-menu-item" disabled={blank || !currentURL} onClick={openExternal}><ArrowUpRight className="icon" aria-hidden="true" /><span>{t("webWorkspace.openExternal")}</span></button>
        </div></FloatingMenuPortal> : null}
        {addressError ? <p className="web-workspace-address-error" id={addressErrorID} role="alert">{addressError}</p> : null}
        <div className="workspace-browser-loading-bar" data-active={current?.loading ? "true" : "false"} aria-hidden="true" />
      </div>
      {findOpen ? <div className="web-workspace-findbar" role="search" aria-label={t("webWorkspace.find")}>
        <Search className="icon" aria-hidden="true" />
        <input ref={findInputRef} value={findText} type="text" aria-label={t("webWorkspace.find")} placeholder={t("webWorkspace.find")} onChange={(event) => { setFindText(event.target.value); find(event.target.value); }} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); closeFind(); }
          if (event.key === "Enter") { event.preventDefault(); find(findText, !event.shiftKey, true); }
        }} />
        <span className="web-workspace-find-count" role="status" aria-live="polite">{findText ? t("webWorkspace.findMatches", { current: current?.findResult?.activeMatchOrdinal ?? 0, total: current?.findResult?.matches ?? 0 }) : ""}</span>
        <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.findPrevious")} title={t("webWorkspace.findPrevious")} disabled={!findText} onClick={() => find(findText, false, true)}><ChevronUp className="icon" aria-hidden="true" /></button>
        <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.findNext")} title={t("webWorkspace.findNext")} disabled={!findText} onClick={() => find(findText, true, true)}><ChevronDown className="icon" aria-hidden="true" /></button>
        <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.closeFind")} title={t("webWorkspace.closeFind")} onClick={closeFind}><X className="icon" aria-hidden="true" /></button>
      </div> : null}
      <div className="web-workspace-content" id={`${instanceID}-page`} role={tabs ? "tabpanel" : undefined} aria-labelledby={tabs && current?.activeTabId ? `${instanceID}-tab-${current.activeTabId}` : undefined}>
        <div ref={hostRef} className="web-workspace-host" data-wuu-native-surface={active && current && !error && !blank ? "" : undefined} />
        {!api || error ? (
          <div className="web-workspace-message" role={error ? "alert" : "status"}>
            <Globe className="icon" aria-hidden="true" />
            <p>{t(!api ? "webWorkspace.unavailable" : "webWorkspace.loadFailed")}</p>
            {error ? <p className="web-workspace-error-detail">{error}</p> : null}
            <div className="web-workspace-message-actions">
              {api ? <button type="button" className="settings-button" onClick={() => void run("reload")}>{t("webWorkspace.retry")}</button> : null}
              <button type="button" className="settings-button settings-button-ghost" disabled={blank} onClick={openExternal}>{t("webWorkspace.openExternal")}</button>
            </div>
          </div>
        ) : blank ? <div className="web-workspace-message web-workspace-new-page"><Globe className="icon" aria-hidden="true" /><button type="button" className="settings-button settings-button-ghost" onClick={focusAddress}>{t("webWorkspace.addressSearch")}</button></div>
          : !current ? <div className="web-workspace-message" role="status"><p>{t("webWorkspace.loading")}</p></div> : null}
      </div>
    </div>
  );
}

type HostRect = { x: number; y: number; width: number; height: number };
const MODALS = '[aria-modal="true"], dialog[open]';
const FLOATING_LAYERS = '[role="dialog"], [role="menu"], [data-wuu-layer="popover"], .plugin-workbench-view-overlay';
const NOTICES = '[data-wuu-layer="notice"]';
const OCCLUDERS = `${MODALS}, ${FLOATING_LAYERS}, ${NOTICES}`;

function focusedWebWorkspacePanel(): Element | undefined {
  const focused = document.activeElement;
  const panels = [...document.querySelectorAll<HTMLElement>(".web-workspace-panel")].filter(visibleElementRect);
  const owner = focused?.closest<HTMLElement>("[data-web-workspace-owner]")?.dataset.webWorkspaceOwner;
  const direct = focused?.closest(".web-workspace-panel");
  const target = panels.find((panel) => panel === direct || panel.dataset.websiteId === owner)
    ?? (focused === document.body || focused === document.documentElement || !focused ? panels[0]
      : panels.find((panel) => panel.closest(".web-workspace-stage")));
  // An auxiliary extension browser never owns shortcuts while the user is
  // typing in a conversation or another workbench surface.
  if (!target || [...document.querySelectorAll(MODALS)].some((layer) => !layer.contains(target) && visibleElementRect(layer))) return;
  return target;
}

function visibleElementRect(element: Element): DOMRect | null {
  if (!(element instanceof HTMLElement) || element.closest('[hidden], [inert]')) return null;
  if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkVisibilityCSS: true })) return null;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

// Native views sit above every renderer layer. Hide the surface for modal UI
// and overlapping menus, then restore the same page when the overlay closes.
function observeWebWorkspaceBounds(host: HTMLElement, report: (bounds: HostRect | null) => void): () => void {
  let last = "";
  let frame = 0;
  const movingLayers = new Set<Element>();
  const send = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const rect = visibleElementRect(host);
    let bounds: HostRect | null = rect && document.visibilityState !== "hidden" ? {
      x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
    } : null;
    if (bounds) {
      for (const overlay of document.querySelectorAll(OCCLUDERS)) {
        if (overlay.contains(host)) continue;
        const obstacle = visibleElementRect(overlay);
        if (!obstacle) continue;
        const overlaps = obstacle.left < bounds.x + bounds.width && obstacle.right > bounds.x
          && obstacle.top < bounds.y + bounds.height && obstacle.bottom > bounds.y;
        if (overlay.matches(NOTICES) && overlaps) {
          // A top notice only reserves its shallow strip. Keep the rest of the
          // page usable instead of blanking it for the toast's entire lifetime.
          const bottom = bounds.y + bounds.height;
          bounds.y = Math.min(bottom, Math.ceil(obstacle.bottom + 4));
          bounds.height = bottom - bounds.y;
          if (bounds.height > 0) continue;
        }
        if (overlay.matches(MODALS) || overlaps) {
          bounds = null;
          break;
        }
      }
    }
    const key = JSON.stringify(bounds);
    if (key !== last) { last = key; report(bounds); }
    for (const layer of movingLayers) if (!layer.isConnected) movingLayers.delete(layer);
    if (movingLayers.size) frame = requestAnimationFrame(send);
  };
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(send); };
  const onMotionStart = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.matches(OCCLUDERS)) return;
    movingLayers.add(event.target);
    schedule();
  };
  const onMotionEnd = (event: Event): void => {
    if (!(event.target instanceof Element) || !movingLayers.has(event.target)) return;
    movingLayers.delete(event.target);
    schedule();
  };
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(send) : undefined;
  resized?.observe(host);
  const mutation = new MutationObserver((records) => {
    if (records.some((record) => {
      if (record.type === "attributes") {
        const target = record.target;
        return target instanceof Element && (target.contains(host) || target.matches(OCCLUDERS));
      }
      return [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.contains(host) || node.matches(OCCLUDERS) || node.querySelector(OCCLUDERS)));
    })) send();
  });
  mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "open", "aria-modal", "data-settings-open", "data-web-workspace-open"] });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  document.addEventListener("visibilitychange", send);
  document.addEventListener("animationstart", onMotionStart);
  document.addEventListener("animationend", onMotionEnd);
  document.addEventListener("animationcancel", onMotionEnd);
  send();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    resized?.disconnect();
    mutation.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    document.removeEventListener("visibilitychange", send);
    document.removeEventListener("animationstart", onMotionStart);
    document.removeEventListener("animationend", onMotionEnd);
    document.removeEventListener("animationcancel", onMotionEnd);
    report(null);
  };
}
