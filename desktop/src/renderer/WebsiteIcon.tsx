import { useState, type ReactNode } from "react";
import notionLight from "../../../internal/plugin/bundled/notion-workspace/icons/notion-light.svg";
import notionDark from "../../../internal/plugin/bundled/notion-workspace/icons/notion-dark.svg";
import feishuLight from "../../../internal/plugin/bundled/feishu-workspace/icon-light.svg";
import feishuDark from "../../../internal/plugin/bundled/feishu-workspace/icon-dark.svg";
import chatgptLight from "../../../internal/plugin/bundled/chatgpt-workspace/icon-light.svg";
import chatgptDark from "../../../internal/plugin/bundled/chatgpt-workspace/icon-dark.svg";

const websiteMarks = [
  { name: "notion", domains: ["notion.so", "notion.site"], light: notionLight, dark: notionDark },
  { name: "feishu", domains: ["feishu.cn"], light: feishuLight, dark: feishuDark },
  { name: "chatgpt", domains: ["chatgpt.com"], light: chatgptLight, dark: chatgptDark },
];

/** Local service marks, independent of whether an optional integration is enabled. */
export function WebsiteIcon({ url, favicon, className, fallback }: {
  url: string;
  favicon?: string;
  className?: string;
  fallback: ReactNode;
}): JSX.Element {
  const [failedFavicon, setFailedFavicon] = useState<string>();
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return <>{fallback}</>;
    hostname = parsed.hostname.replace(/\.$/, "");
  } catch {
    return <>{fallback}</>;
  }
  // Match complete DNS labels, including hosted workspace subdomains, never a
  // title or a substring. A service mark does not endorse tenant-owned content.
  const mark = websiteMarks.find(({ domains }) => domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)));
  if (!mark) {
    if (favicon && favicon !== failedFavicon && /^(?:https?:|data:image\/)/i.test(favicon)) {
      return <img className={`sidebar-ribbon-favicon ${className ?? ""}`} src={favicon} alt="" aria-hidden="true" onError={() => setFailedFavicon(favicon)} />;
    }
    return <>{fallback}</>;
  }
  // Reuse the canonical bundled SVGs and their adjacent attribution; importing
  // them at build time needs no plugin activation, IPC, or remote favicon request.
  return <span className={`plugin-icon-themed ${className ?? ""}`} data-website-brand={mark.name} aria-hidden="true">
    <img className="plugin-icon-asset plugin-icon-asset-light" src={mark.light} alt="" />
    <img className="plugin-icon-asset plugin-icon-asset-dark" src={mark.dark} alt="" />
  </span>;
}
