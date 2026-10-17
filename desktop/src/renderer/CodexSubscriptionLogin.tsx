import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";

/** The installed official CLI owns authorization and credential storage. */
export function CodexSubscriptionLogin({ onAuthenticated, onBusyChange, disabled = false }: {
  onAuthenticated: () => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState<{ url: string; code: string }>();
  const operation = useRef<{ id?: string; timer?: number } | undefined>(undefined);
  const mounted = useRef(true);
  const authenticated = useRef(onAuthenticated);
  authenticated.current = onAuthenticated;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = operation.current;
      operation.current = undefined;
      if (current?.timer) window.clearTimeout(current.timer);
      if (current?.id) void window.wuu.cancelCodexLogin(current.id).catch(() => {});
    };
  }, []);

  function finish(): void {
    operation.current = undefined;
    setBusy(false);
    setChallenge(undefined);
    onBusyChange?.(false);
  }

  async function start(): Promise<void> {
    if (operation.current || busy || disabled) return;
    const current: { id?: string; timer?: number } = {};
    operation.current = current;
    setError("");
    setChallenge(undefined);
    setBusy(true);
    onBusyChange?.(true);
    try {
      const login = await window.wuu.startCodexLogin();
      current.id = login.login_id;
      if (operation.current !== current) {
        await window.wuu.cancelCodexLogin(login.login_id);
        if (mounted.current && !operation.current) finish();
        return;
      }
      const poll = async (): Promise<void> => {
        try {
          const result = await window.wuu.pollCodexLogin(login.login_id);
          if (operation.current !== current) return;
          if (result.status === "pending") {
            if (result.verification_uri && result.user_code) setChallenge({ url: result.verification_uri, code: result.user_code });
            current.timer = window.setTimeout(() => void poll(), Math.max(250, login.interval_ms));
            return;
          }
          finish();
          if (result.status === "success") authenticated.current();
          else setError(result.error || t("provider.codexLoginIncomplete"));
        } catch (cause) {
          if (operation.current !== current) return;
          // Poll transport failure does not stop the underlying CLI.
          void window.wuu.cancelCodexLogin(login.login_id).catch(() => {});
          finish();
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      };
      current.timer = window.setTimeout(() => void poll(), Math.max(250, login.interval_ms));
    } catch (cause) {
      if (!mounted.current || (operation.current && operation.current !== current)) return;
      finish();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function cancel(): Promise<void> {
    const current = operation.current;
    if (!current) return;
    if (current.timer) window.clearTimeout(current.timer);
    operation.current = undefined;
    setChallenge(undefined);
    if (current.id) {
      try { await window.wuu.cancelCodexLogin(current.id); }
      catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted.current) finish(); }
    }
    // A start still awaiting admission cancels its returned ID before finishing.
  }

  return <div className="settings-engine-auth" aria-busy={busy}>
    <p className="settings-muted-line">{t("provider.codexLoginHint")}</p>
    <p className="settings-muted-line">{t("provider.codexStorageHint")}</p>
    <div className="settings-engine-auth-actions">
      <button type="button" className="settings-button" data-testid="codex-login-start" disabled={busy || disabled} onClick={() => void start()}>{t("provider.codexSignIn")}</button>
      {busy ? <button type="button" className="settings-button" data-testid="codex-login-cancel" onClick={() => void cancel()}>{t("common.cancel")}</button> : null}
      <button type="button" className="settings-button settings-button-ghost" disabled={busy} onClick={() => void window.wuu.openExternal("https://developers.openai.com/codex/cli/").catch((cause) => setError(String(cause)))}>{t("provider.codexInstall")}</button>
    </div>
    {challenge ? <div role="status">
      <p>{t("provider.codexLoginCode", { code: challenge.code })}</p>
      <button type="button" className="settings-button" onClick={() => void window.wuu.openExternal(challenge.url).catch((cause) => setError(String(cause)))}>{t("provider.codexOpenLogin")}</button>
    </div> : busy ? <p className="settings-muted-line" role="status">{t("settings.engineSigningIn")}</p> : null}
    {error ? <p className="environment-dialog-error" role="alert">{error}</p> : null}
  </div>;
}
