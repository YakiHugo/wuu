import type { CSSProperties } from "react";
import { SIDEBAR_RIBBON_WIDTH } from "./AppLayoutState";
import { useI18n } from "./i18n";
import { desktopPlatform } from "./platform";
import "./styles/mac-window-controls.css";

/** Compact traffic lights with native window actions, independent of AppKit chrome. */
export function MacWindowControls(): JSX.Element | null {
  const { t } = useI18n();
  if (desktopPlatform() !== "darwin" ||
      (window.wuu?.hostKind ?? "desktop") !== "desktop" ||
      typeof window.wuu?.windowToggleFullScreen !== "function") return null;

  return (
    <div className="mac-window-controls" role="group" aria-label={t("shell.windowControls")}
      style={{ "--mac-ribbon-width": `${SIDEBAR_RIBBON_WIDTH}px` } as CSSProperties}>
      <button type="button" className="mac-window-control mac-window-close"
        aria-label={t("shell.closeWindow")} title={t("shell.closeWindow")}
        onClick={() => { void window.wuu.windowClose?.(); }}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="m3 3 4 4m0-4L3 7" /></svg>
      </button>
      <button type="button" className="mac-window-control mac-window-minimize"
        aria-label={t("shell.minimizeWindow")} title={t("shell.minimizeWindow")}
        onClick={() => { void window.wuu.windowMinimize?.(); }}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 5h5" /></svg>
      </button>
      <button type="button" className="mac-window-control mac-window-fullscreen"
        aria-label={t("shell.toggleFullScreen")} title={t("shell.toggleFullScreen")}
        onClick={(event) => {
          if (event.altKey) void window.wuu.windowToggleMaximize?.();
          else void window.wuu.windowToggleFullScreen?.();
        }}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 5V2.5H5m0 5h2.5V5" /></svg>
      </button>
    </div>
  );
}
