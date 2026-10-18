import { type FormEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { ArrowLeft } from "./WuuIcons";
import { useI18n } from "./i18n";

export type ConnectionPageProps = {
  title: ReactNode;
  ariaLabel?: string;
  icon?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  backTestId?: string;
  panelClassName?: string;
  asForm?: boolean;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

/** Page-contained connection settings with ordinary navigation and form behavior. */
export function ConnectionPage({
  title,
  ariaLabel,
  icon,
  subtitle,
  children,
  footer,
  onClose,
  closeDisabled = false,
  backTestId = "settings-connection-back",
  panelClassName,
  asForm = false,
  onSubmit,
}: ConnectionPageProps): JSX.Element {
  const { t } = useI18n();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const content = <>
    <button
      type="button"
      className="settings-button settings-button-ghost connection-page-back"
      data-testid={backTestId}
      disabled={closeDisabled}
      onClick={onClose}
    >
      <ArrowLeft className="icon" />
      {t("common.back")}
    </button>
    <header className="connection-page-header">
      {icon ? <span className="connection-page-icon">{icon}</span> : null}
      <div className="connection-page-heading">
        <h2 ref={heading} tabIndex={-1} id={titleId} className="connection-page-title">{title}</h2>
        {subtitle ? <p className="connection-page-subtitle">{subtitle}</p> : null}
      </div>
    </header>
    <div className="connection-page-body">{children}</div>
    {footer ? <div className="connection-page-footer">{footer}</div> : null}
  </>;
  return <section
    className={["connection-page", panelClassName].filter(Boolean).join(" ")}
    role="region"
    aria-label={ariaLabel}
    aria-labelledby={ariaLabel ? undefined : titleId}
  >
    {asForm ? <form className="connection-page-form" onSubmit={event => {
      event.preventDefault();
      onSubmit?.(event);
    }}>{content}</form> : content}
  </section>;
}
