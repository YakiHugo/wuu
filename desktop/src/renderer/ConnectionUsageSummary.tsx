import type { SubscriptionQuota } from "../shared/protocol";
import { useI18n } from "./i18n";

/** A read-only account snapshot. Fetching and cache identity belong to the connection owner. */
export function ConnectionUsageSummary({ quota, loading = false, now = Date.now() }: {
  quota?: SubscriptionQuota;
  loading?: boolean;
  now?: number;
}): JSX.Element {
  const { t, formatNumber, formatDate } = useI18n();
  if (!quota) return <span className="connection-usage-summary connection-usage-state" aria-busy={loading}>
    {t(loading ? "settings.subscriptionRefreshing" : "settings.subscriptionQuotaUnknown")}
  </span>;

  const observed = quota.status === "available" || quota.status === "stale";
  const expired = quota.status === "stale" || (quota.expires_at !== undefined && Date.parse(quota.expires_at) <= now);
  const statusKey = quota.status === "sign_in" ? "settings.subscriptionSignIn"
    : quota.status === "unsupported" ? "settings.subscriptionQuotaUnsupported"
      : quota.status === "unavailable" ? "settings.subscriptionQuotaUnavailable"
        : quota.status === "stale" ? "settings.subscriptionQuotaRefreshFailed"
          : expired ? "settings.subscriptionQuotaStale" : undefined;
  const windows = observed ? quota.windows ?? [] : [];
  const balances = observed ? quota.balances ?? [] : [];
  return <span className="connection-usage-summary" aria-label={t("provider.accountUsage")}>
    {statusKey ? <span className="connection-usage-state">{t(statusKey)}</span> : null}
    {windows.map(window => {
      // The protocol reports consumed percent, never a remaining fraction.
      // Missing/nonfinite values must not turn into a full or empty allowance.
      const percent = window.used_percent;
      const remaining = typeof percent === "number" && Number.isFinite(percent) && percent >= 0
        ? Math.max(0, 100 - percent) : undefined;
      const minutes = window.window_minutes;
      const period = minutes && minutes > 0 ? minutes % 1440 === 0 ? t("settings.subscriptionDays", { count: minutes / 1440 })
        : minutes % 60 === 0 ? t("settings.subscriptionHours", { count: minutes / 60 })
          : t("settings.subscriptionMinutes", { count: minutes }) : undefined;
      const periodOnly = /^(?:\d+ (?:hours|days|minutes)|Primary|Secondary|Daily|Weekly|Weekly allowance|Rolling window|Requests|Allowance)$/i.test(window.label ?? "");
      const label = (periodOnly && period ? period : [window.label, period].filter(Boolean).join(" · ")) || t("settings.subscriptionAllowance");
      const scope = [...new Set([window.model, window.scope].filter(value => value && value.toLowerCase() !== "all models"))].join(" · ");
      const resetMillis = window.resets_at ? Date.parse(window.resets_at) : NaN;
      const pastReset = Number.isFinite(resetMillis) && resetMillis <= now;
      const lastKnown = expired || pastReset;
      const remainingReadout = window.unlimited ? t(lastKnown ? "settings.subscriptionLastKnownUnlimited" : "settings.subscriptionUnlimited")
        : remaining === undefined ? t("settings.subscriptionQuotaUnknown")
          : t("settings.subscriptionRemaining", { percent: formatNumber(remaining, { maximumFractionDigits: 1 }) });
      const readout = !window.unlimited && remaining !== undefined
        ? t(lastKnown ? "settings.subscriptionLastKnownUsed" : "settings.subscriptionUsed", { percent: formatNumber(percent!, { maximumFractionDigits: 1 }) })
        : remainingReadout;
      const resetTitle = Number.isFinite(resetMillis) ? t("settings.subscriptionResetTime", {
        time: formatDate(resetMillis, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
      }) : undefined;
      const resetMinutes = Math.max(1, Math.ceil((resetMillis - now) / 60_000));
      const duration = resetMinutes < 60 ? t("settings.subscriptionMinutes", { count: resetMinutes })
        : resetMinutes < 1440 ? [t("settings.subscriptionHours", { count: Math.floor(resetMinutes / 60) }), resetMinutes % 60 ? t("settings.subscriptionMinutes", { count: resetMinutes % 60 }) : ""].filter(Boolean).join(" ")
          : [t("settings.subscriptionDays", { count: Math.floor(resetMinutes / 1440) }), Math.floor(resetMinutes % 1440 / 60) ? t("settings.subscriptionHours", { count: Math.floor(resetMinutes % 1440 / 60) }) : ""].filter(Boolean).join(" ");
      return <span className="connection-usage-window" key={window.id} data-exhausted={!lastKnown && !window.unlimited && remaining === 0}>
        <span className="connection-usage-heading"><span>{[label, scope].filter(Boolean).join(" · ")}</span><span>{readout}</span></span>
        {!lastKnown && !window.unlimited && remaining !== undefined ? <meter min={0} max={100} value={Math.min(100, percent!)} aria-label={[label, scope].filter(Boolean).join(" · ")} aria-valuetext={readout} title={remainingReadout} /> : null}
        {window.display ? <span className="connection-usage-display">{window.display}</span> : null}
        {resetTitle ? <time className="connection-usage-reset" dateTime={window.resets_at} title={resetTitle} aria-label={resetTitle}>
          {pastReset ? resetTitle : t("settings.subscriptionResetsIn", { time: duration })}
        </time> : null}
      </span>;
    })}
    {balances.length ? <span className="connection-usage-balance">{t("settings.subscriptionKindBalance")}{" · "}
      {balances.map(balance => `${balance.amount} ${balance.currency}`).join(" · ")}
    </span> : null}
    {!statusKey && !windows.length && !balances.length ? <span className="connection-usage-state">{t("settings.subscriptionQuotaUnknown")}</span> : null}
  </span>;
}
