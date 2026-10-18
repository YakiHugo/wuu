import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubscriptionQuota } from "../shared/protocol";
import { ConnectionUsageSummary } from "./ConnectionUsageSummary";

const now = Date.parse("2026-10-18T12:00:00Z");
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(overrides?: Partial<SubscriptionQuota>) {
  const quota: SubscriptionQuota | undefined = overrides && {
    status: "available", checked_at: "2026-10-18T12:00:00Z", ...overrides,
  };
  act(() => root.render(<ConnectionUsageSummary quota={quota} now={now} />));
}

describe("ConnectionUsageSummary account allowance contract", () => {
  it("keeps short and weekly allowances and their reset instants separate", () => {
    render({ windows: [
      { id: "short", window_minutes: 300, used_percent: 25, resets_at: "2026-10-18T14:00:00Z" },
      { id: "weekly", window_minutes: 10080, used_percent: 80, resets_at: "2026-10-23T12:00:00Z" },
    ] });
    const meters = [...container.querySelectorAll("meter")];
    expect(meters.map(meter => meter.value)).toEqual([25, 80]);
    expect(meters[0].parentElement?.textContent).toContain("25");
    expect(meters[0].getAttribute("aria-valuetext")).toContain("25");
    expect(meters[1].parentElement?.textContent).toContain("80");
    expect(meters[1].getAttribute("aria-valuetext")).toContain("80");
    expect(meters[0].getAttribute("aria-label")).not.toBe(meters[1].getAttribute("aria-label"));
    expect([...container.querySelectorAll("time")].map(time => time.dateTime)).toEqual([
      "2026-10-18T14:00:00Z", "2026-10-23T12:00:00Z",
    ]);
  });

  it("never presents missing, invalid or unlimited allowances as a finite meter", () => {
    render();
    expect(container.textContent?.length).toBeGreaterThan(0);
    expect(container.querySelector("meter")).toBeNull();
    render({ windows: [undefined, NaN, Infinity, -1].map((used_percent, index) => ({ id: String(index), used_percent })) });
    expect(container.querySelector("meter")).toBeNull();
    render({ windows: [{ id: "unlimited", used_percent: 0, unlimited: true }] });
    expect(container.querySelector("meter")).toBeNull();
  });

  it("preserves valid zero-use and exhausted observations without inventing capacity", () => {
    render({ windows: [{ id: "unused", used_percent: 0 }, { id: "over", used_percent: 120 }] });
    expect([...container.querySelectorAll("meter")].map(meter => meter.value)).toEqual([0, 100]);
  });

  it("does not show expired, stale or failed snapshots as live capacity", () => {
    const windows = [{ id: "short", used_percent: 20 }];
    for (const status of ["stale", "unavailable", "unsupported", "sign_in"] as const) {
      render({ status, windows });
      expect(container.querySelector("meter")).toBeNull();
      expect(container.textContent?.length).toBeGreaterThan(0);
    }
    render({ windows, expires_at: "2026-10-18T11:59:00Z" });
    expect(container.querySelector("meter")).toBeNull();
    render({ windows: [{ ...windows[0], resets_at: "2026-10-18T11:59:00Z" }] });
    expect(container.querySelector("meter")).toBeNull();
  });

  it("preserves supplied balance precision, display and model scope without guessing a percentage", () => {
    render({ balances: [{ currency: "USD", amount: "0.0123456789" }], windows: [
      { id: "requests", display: "7 / 40 requests", model: "special-model", scope: "organization" },
    ] });
    expect(container.textContent).toContain("0.0123456789");
    expect(container.textContent).toContain("7 / 40 requests");
    expect(container.textContent).toContain("special-model");
    expect(container.textContent).toContain("organization");
    expect(container.querySelector("meter")).toBeNull();
  });
});
