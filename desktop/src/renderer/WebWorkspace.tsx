import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { WebWorkspaceApi, WebWorkspaceState } from "../shared/webWorkspace";
import { ArrowLeft, ArrowRight, ArrowUpRight, Globe, RotateCw, X } from "./WuuIcons";
import { useI18n } from "./i18n";
import { normalizeWebsiteURL } from "./NavigationRibbonPreferences";
import { rawErrorMessage } from "./UserFacingErrors";
import { showActionErrorToast } from "./Toast";
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
}: {
  site?: WebWorkspaceSite;
  active?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const api = (window.wuu as typeof window.wuu & { webWorkspace?: WebWorkspaceApi }).webWorkspace;
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<WebWorkspaceState>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const addressErrorID = useId();
  const homeURLs = useRef(new Map<string, string>());
  const currentSiteID = useRef(site?.id);
  currentSiteID.current = site?.id;
  const current = page?.id === site?.id ? page : undefined;
  const error = failure && failure.id === site?.id ? failure.message : current?.error;
  const currentURL = current?.url || site?.url || "";

  useEffect(() => {
    if (!api) return;
    return api.onState((next) => {
      if (next.id !== currentSiteID.current) return;
      setPage(next);
    });
  }, [api]);

  useEffect(() => {
    if (!api || !active) return;
    return api.onFocusAddress((id) => {
      if (id !== currentSiteID.current || !hostRef.current || !visibleElementRect(hostRef.current)) return;
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [api, active]);

  useEffect(() => {
    if (!api || !site) return;
    let disposed = false;
    const { id, url } = site;
    const previousHome = homeURLs.current.get(id);
    homeURLs.current.set(id, url);
    setFailure(undefined);
    void api.open({ id, url }).then(async (next) => {
      if (disposed) return;
      // Editing the saved address changes this destination. Merely switching
      // away and back must retain the page and its native navigation history.
      if (previousHome && previousHome !== url) next = await api.command(id, "navigate", url);
      if (!disposed) setPage(next);
    }).catch((cause: unknown) => {
      if (!disposed) setFailure({ id, message: rawErrorMessage(cause) });
    });
    return () => { disposed = true; };
  }, [api, site?.id, site?.url]);

  useEffect(() => {
    setAddress(currentURL);
    setAddressError("");
  }, [currentURL, site?.id]);

  const run = useCallback(async (action: "back" | "forward" | "reload" | "stop" | "navigate", url?: string): Promise<void> => {
    if (!api || !site) return;
    const { id } = site;
    setFailure(undefined);
    try {
      // A failed initial creation is retryable through the same address bar.
      if (!current || action === "reload") await api.open({ id, url: url ?? current?.url ?? site.url });
      const next = await api.command(id, action, url);
      if (currentSiteID.current === id) setPage(next);
    } catch (cause) {
      if (currentSiteID.current === id) setFailure({ id, message: rawErrorMessage(cause) });
    }
  }, [api, current, site]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const id = site?.id;
    if (!api || !id || !host || !current) return;
    if (!active || error) {
      void api.reportBounds(id, null).catch(() => undefined);
      return;
    }
    return observeWebWorkspaceBounds(host, (bounds) => {
      void api.reportBounds(id, bounds).catch((cause: unknown) => {
        if (currentSiteID.current === id) setFailure({ id, message: rawErrorMessage(cause) });
      });
    });
  }, [api, site?.id, active, Boolean(current), error]);

  useEffect(() => {
    if (!active || !site) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "l") {
        // Plugin pages can be retained in an inert region behind another page.
        if (!hostRef.current || !visibleElementRect(hostRef.current)) return;
        const panel = hostRef.current.closest(".web-workspace-panel");
        const focusedPanel = document.activeElement?.closest(".web-workspace-panel");
        const target = focusedPanel ?? [...document.querySelectorAll(".web-workspace-panel")].find(visibleElementRect);
        if (target !== panel) return;
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, site?.id]);

  const submitAddress = (event: FormEvent): void => {
    event.preventDefault();
    const url = normalizeWebsiteURL(address);
    if (!url) {
      setAddressError(t("webWorkspace.invalidURL"));
      return;
    }
    setAddress(url);
    setAddressError("");
    inputRef.current?.blur();
    void run("navigate", url);
  };
  const openExternal = (): void => {
    const url = normalizeWebsiteURL(currentURL);
    if (url) void window.wuu.openExternal(url).catch((cause: unknown) => showActionErrorToast(rawErrorMessage(cause)));
  };

  return (
    <div className="web-workspace-panel" data-wuu-component="web-workspace" data-website-id={site?.id}>
      <div className="workspace-browser-toolbar web-workspace-toolbar" role="toolbar" aria-label={site?.title || t("webWorkspace.address")}>
        <div className="workspace-browser-nav-cluster">
          <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.back")} title={t("webWorkspace.back")} disabled={!api || !current?.canGoBack} onClick={() => void run("back")}><ArrowLeft className="icon" aria-hidden="true" /></button>
          <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.forward")} title={t("webWorkspace.forward")} disabled={!api || !current?.canGoForward} onClick={() => void run("forward")}><ArrowRight className="icon" aria-hidden="true" /></button>
          <button type="button" className="icon-button workspace-browser-nav" aria-label={t(current?.loading ? "webWorkspace.stop" : "webWorkspace.reload")} title={t(current?.loading ? "webWorkspace.stop" : "webWorkspace.reload")} disabled={!api || !site} onClick={() => void run(current?.loading ? "stop" : "reload")}>{current?.loading ? <X className="icon" aria-hidden="true" /> : <RotateCw className="icon" aria-hidden="true" />}</button>
        </div>
        <form className="workspace-browser-url-form web-workspace-address" onSubmit={submitAddress}>
          <input ref={inputRef} className="workspace-browser-url-input" value={address} type="text" inputMode="url" spellCheck={false} autoCorrect="off" autoCapitalize="off" aria-label={t("webWorkspace.address")} disabled={!site || !api} aria-invalid={Boolean(addressError)} aria-describedby={addressError ? addressErrorID : undefined} onChange={(event) => { setAddress(event.target.value); setAddressError(""); }} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => {
            if (event.key === "Escape") { setAddress(currentURL); event.currentTarget.blur(); }
          }} />
        </form>
        <button type="button" className="icon-button workspace-browser-nav" aria-label={t("webWorkspace.openExternal")} title={t("webWorkspace.openExternal")} disabled={!currentURL} onClick={openExternal}><ArrowUpRight className="icon" aria-hidden="true" /></button>
        {addressError ? <p className="web-workspace-address-error" id={addressErrorID} role="alert">{addressError}</p> : null}
        <div className="workspace-browser-loading-bar" data-active={current?.loading ? "true" : "false"} aria-hidden="true" />
      </div>
      <div className="web-workspace-content">
        <div ref={hostRef} className="web-workspace-host" data-wuu-native-surface={active && current && !error ? "" : undefined} />
        {!api || error ? (
          <div className="web-workspace-message" role={error ? "alert" : "status"}>
            <Globe className="icon" aria-hidden="true" />
            <p>{t(!api ? "webWorkspace.unavailable" : "webWorkspace.loadFailed")}</p>
            {error ? <p className="web-workspace-error-detail">{error}</p> : null}
            <div className="web-workspace-message-actions">
              {api ? <button type="button" className="settings-button" onClick={() => void run("reload")}>{t("webWorkspace.retry")}</button> : null}
              <button type="button" className="settings-button settings-button-ghost" onClick={openExternal}>{t("webWorkspace.openExternal")}</button>
            </div>
          </div>
        ) : !current ? <div className="web-workspace-message" role="status"><p>{t("webWorkspace.loading")}</p></div> : null}
      </div>
    </div>
  );
}

type HostRect = { x: number; y: number; width: number; height: number };
const MODALS = '[aria-modal="true"], dialog[open]';
const FLOATING_LAYERS = '[role="dialog"], [role="menu"], [data-wuu-layer="popover"], .plugin-workbench-view-overlay';
const NOTICES = '[data-wuu-layer="notice"]';
const OCCLUDERS = `${MODALS}, ${FLOATING_LAYERS}, ${NOTICES}`;

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
