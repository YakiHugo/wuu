import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageHistoryControls } from "./PageHistoryControls";

let root: Root;
let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("page history drawer occlusion", () => {
  it.each([[true, false], [false, false], [true, true], [false, true]])("preserves controls and returns only owned focus when covered (owned=%s, browser=%s)", async (owned, browser) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const back = vi.fn();
    const render = (hidden: boolean) => root.render(
      <div className="app-shell" tabIndex={-1} data-web-workspace-open={browser || undefined}>
        <PageHistoryControls canGoBack canGoForward={false} onBack={back} onForward={vi.fn()} hidden={hidden} />
        <button className="section-sidebar-toggle" hidden={browser}>Toggle</button>
        <nav className="sidebar-ribbon"><button aria-current="page">Active website</button></nav>
        <button className="other-control">Other</button>
      </div>,
    );
    await act(async () => render(false));
    const controls = container.querySelector<HTMLElement>(".shell-page-history-controls")!;
    const historyBack = controls.querySelector<HTMLButtonElement>("button")!;
    const other = container.querySelector<HTMLButtonElement>(".other-control")!;
    const focusTarget = container.querySelector<HTMLElement>(".app-shell")!;
    (owned ? historyBack : other).focus();
    await act(async () => render(true));
    expect(controls.hidden).toBe(true);
    expect(controls.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(owned ? focusTarget : other);
    await act(async () => render(false));
    expect(container.querySelector(".shell-page-history-controls")).toBe(controls);
    expect(controls.hidden).toBe(false);
    expect(controls.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(owned ? focusTarget : other);
    await act(async () => historyBack.click());
    expect(back).toHaveBeenCalledOnce();
  });
});
