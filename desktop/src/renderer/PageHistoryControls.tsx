import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "./WuuIcons";
import { Tooltip } from "./Tooltip";
import { useI18n } from "./i18n";

export type PageHistoryControlsProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  children?: ReactNode;
  hidden?: boolean;
};

export function PageHistoryControls({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  children,
  hidden = false,
}: PageHistoryControlsProps): JSX.Element {
  const { t } = useI18n();
  const controlsRef = useRef<HTMLDivElement>(null);
  const [occluded, setOccluded] = useState(hidden);
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (hidden && controls?.contains(document.activeElement)) {
      // Keep focus outside hover-owned surfaces so hiding these controls cannot
      // turn a temporary ribbon preview into retained keyboard expansion.
      controls.closest<HTMLElement>(".app-shell")?.focus({ preventScroll: true });
    }
    // Move focus before the browser can blur a hidden/inert descendant.
    // The layout update applies occlusion before paint without losing ownership.
    setOccluded(hidden);
  }, [hidden]);
  return (
    <div ref={controlsRef} className="shell-page-history-controls" data-wuu-component="page-history-controls" hidden={occluded} inert={occluded}>
      <Tooltip content={t("app.historyBack")} side="bottom">
        <button
          type="button"
          className="icon-button"
          data-wuu-component="page-history-back"
          aria-label={t("app.historyBack")}
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeft />
        </button>
      </Tooltip>
      <Tooltip content={t("app.historyForward")} side="bottom">
        <button
          type="button"
          className="icon-button"
          data-wuu-component="page-history-forward"
          aria-label={t("app.historyForward")}
          disabled={!canGoForward}
          onClick={onForward}
        >
          <ArrowRight />
        </button>
      </Tooltip>
      {children}
    </div>
  );
}
