import { createContext, useLayoutEffect, useRef, useState } from "react";
import type { ChromeAccountTrigger, ChromeDesktopUpdate, ChromeOverlayApi, ChromeOverlayCommand, ChromeOverlayModel, ChromeOverlayRect, ChromeOverlayRequest } from "../shared/chromeOverlay";
import { CHROME_OVERLAY_VERSION } from "../shared/chromeOverlay";
import { useI18n } from "./i18n";

export const NativeRibbonFooterContext = createContext<{
  publishAccount: (trigger: ChromeAccountTrigger | undefined, open?: (bounds: ChromeOverlayRect) => void) => void;
  publishUpdate: (model: ChromeDesktopUpdate | undefined, activate?: () => void) => void;
} | null>(null);

export function chromeOverlayApi(): ChromeOverlayApi | undefined {
  return (window.wuu as typeof window.wuu & { chromeOverlay?: ChromeOverlayApi })?.chromeOverlay;
}

/** Models contain presentation data; callbacks and account/browser authority stay here. */
export function useChromeOverlay(enabled: boolean, bounds: ChromeOverlayRect | null, model: ChromeOverlayModel,
  onCommand: (command: ChromeOverlayCommand) => void, onDismiss: () => void, focus = false, appearanceElement?: HTMLElement | null): boolean {
  const api = chromeOverlayApi();
  const { locale } = useI18n();
  const token = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const callbacks = useRef({ onCommand, onDismiss });
  callbacks.current = { onCommand, onDismiss };
  const [appearanceRevision, setAppearanceRevision] = useState(0);
  const active = Boolean(api && enabled && bounds);
  const modelKey = JSON.stringify(model), boundsKey = JSON.stringify(bounds);
  useLayoutEffect(() => {
    if (!active) return;
    const changed = () => setAppearanceRevision(value => value + 1);
    const observer = new MutationObserver(changed);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    if (!api) return;
    return api.onEvent(event => {
      if (event.token !== token.current || event.generation !== generation.current) return;
      callbacks.current.onCommand(event.command);
      if (event.command.type === "dismiss") callbacks.current.onDismiss();
    });
  }, [api]);
  useLayoutEffect(() => {
    if (!api || !active || !bounds) return;
    const computed = getComputedStyle(appearanceElement ?? document.documentElement);
    const variables: Record<string, string> = {};
    // Keep user/theme tokens without accepting CSS rules or external resources.
    for (const name of computed) {
      if (!name.startsWith("--")) continue;
      const value = computed.getPropertyValue(name).trim();
      if (value.length <= 512 && !/url\s*\(/i.test(value)) variables[name] = value;
    }
    const current = ++generation.current;
    const request: ChromeOverlayRequest = { version: CHROME_OVERLAY_VERSION, token: token.current, generation: current,
      bounds, model, focus, appearance: { theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", locale, fontFamily: computed.fontFamily, variables } };
    void api.show(request).catch(() => { if (generation.current === current) callbacks.current.onDismiss(); });
  }, [api, active, modelKey, boundsKey, locale, appearanceRevision, focus, appearanceElement]);
  useLayoutEffect(() => {
    if (!api || !active) return;
    return () => { void api.hide(token.current, generation.current); };
  }, [api, active]);
  return active;
}
