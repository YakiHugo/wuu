import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexSubscriptionLogin } from "./CodexSubscriptionLogin";

let container: HTMLDivElement;
let root: Root | undefined;
const start = vi.fn();
const poll = vi.fn();
const cancel = vi.fn();
const authenticated = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  start.mockReset().mockResolvedValue({ login_id: "fixture", interval_ms: 1000, expires_in: 900 });
  poll.mockReset().mockResolvedValue({ status: "pending", verification_uri: "https://auth.openai.com/codex/device", user_code: "TEST-CODE" });
  cancel.mockReset().mockResolvedValue({ ok: true });
  authenticated.mockReset();
  vi.stubGlobal("wuu", { startCodexLogin: start, pollCodexLogin: poll, cancelCodexLogin: cancel });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<CodexSubscriptionLogin onAuthenticated={authenticated} />));
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const button = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
it("only launches on explicit click and ignores repeated starts", async () => {
  expect(start).not.toHaveBeenCalled();
  await act(async () => { button("codex-login-start").click(); button("codex-login-start").click(); });
  expect(start).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.textContent).toContain("TEST-CODE");
  expect(authenticated).not.toHaveBeenCalled();
  poll.mockResolvedValue({ status: "success" });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(authenticated).toHaveBeenCalledTimes(1);
});
it("cancels on dismissal even when process admission finishes late", async () => {
  let resolve!: (value: unknown) => void;
  start.mockReturnValue(new Promise((done) => { resolve = done; }));
  await act(async () => button("codex-login-start").click());
  act(() => { root!.unmount(); root = undefined; });
  await act(async () => resolve({ login_id: "late", interval_ms: 1000 }));
  expect(cancel).toHaveBeenCalledWith("late");
  expect(poll).not.toHaveBeenCalled();
  expect(authenticated).not.toHaveBeenCalled();
});
it("cancels explicitly and ignores a late success response", async () => {
  let resolve!: (value: unknown) => void;
  poll.mockReturnValue(new Promise((done) => { resolve = done; }));
  await act(async () => button("codex-login-start").click());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => button("codex-login-cancel").click());
  await act(async () => resolve({ status: "success" }));
  expect(cancel).toHaveBeenCalledWith("fixture");
  expect(authenticated).not.toHaveBeenCalled();
  expect(button("codex-login-start").disabled).toBe(false);
});
it("keeps failed login retryable without reporting authentication", async () => {
  poll.mockResolvedValue({ status: "failed", error: "fixture login failed" });
  await act(async () => button("codex-login-start").click());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.textContent).toContain("fixture login failed");
  expect(authenticated).not.toHaveBeenCalled();
  expect(button("codex-login-start").disabled).toBe(false);
});
it("waits for cancellation acknowledgement before allowing another login", async () => {
  let resolveCancel!: (value: unknown) => void;
  cancel.mockReturnValue(new Promise((done) => { resolveCancel = done; }));
  await act(async () => button("codex-login-start").click());
  await act(async () => button("codex-login-cancel").click());
  expect(button("codex-login-start").disabled).toBe(true);
  await act(async () => resolveCancel({ ok: true }));
  expect(button("codex-login-start").disabled).toBe(false);
});
