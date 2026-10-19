import * as React from "react";
import type { PluginUIWebPageProps } from "../../shared/workbench";
import type { WebWorkspaceApi } from "../../shared/webWorkspace";
import { WebWorkspacePanel } from "../WebWorkspace";

/** Only views owning a native page need to survive ordinary tab switches. */
export const PluginWebPageViewContext = React.createContext<{
  active: boolean;
  retain: () => () => void;
} | undefined>(undefined);

/** Bind the existing website surface to the extension generation's lifetime. */
export function createPluginWebPage(
  react: typeof React,
  signal: AbortSignal,
  reportError: (error: unknown) => void,
): React.ComponentType<PluginUIWebPageProps> {
  const subscribe = (listener: () => void): (() => void) => {
    signal.addEventListener("abort", listener);
    return () => signal.removeEventListener("abort", listener);
  };
  const isActive = (): boolean => !signal.aborted;

  return function PluginWebPage({ url, title }: PluginUIWebPageProps): React.ReactNode {
    const [id] = react.useState(() => `plugin-web-page:${crypto.randomUUID()}`);
    const generationActive = react.useSyncExternalStore(subscribe, isActive, isActive);
    const view = react.useContext(PluginWebPageViewContext);
    const site = react.useMemo(() => ({ id, url, title }), [id, url, title]);

    react.useLayoutEffect(() => view?.retain(), [view?.retain]);

    react.useEffect(() => {
      const close = (): void => {
        const browser = (window.wuu as typeof window.wuu & { webWorkspace?: WebWorkspaceApi })?.webWorkspace;
        if (browser) void browser.close(id).catch(reportError);
      };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
      return () => {
        signal.removeEventListener("abort", close);
        close();
      };
    }, [id]);

    return generationActive ? react.createElement(WebWorkspacePanel, {
      site,
      active: view?.active ?? true,
    }) : null;
  };
}
