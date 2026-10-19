import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "./WuuIcons";
import { Tooltip } from "./Tooltip";
import { useI18n } from "./i18n";

export type PageHistoryControlsProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  children?: ReactNode;
};

export function PageHistoryControls({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  children,
}: PageHistoryControlsProps): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="shell-page-history-controls" data-wuu-component="page-history-controls">
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
