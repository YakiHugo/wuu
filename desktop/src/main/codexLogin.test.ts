import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthCodexLoginResult, RuntimeContext } from "../shared/protocol";
import { CodexLoginCoordinator } from "./codexLogin";
import { AppServerResponseError } from "./appServerErrors";

class Owner extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) { super(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
const context: RuntimeContext = { kind: "project", project_id: "one", cwd: "/fixture/one" };
const otherContext: RuntimeContext = { kind: "project", project_id: "two", cwd: "/fixture/two" };
const pending: AuthCodexLoginResult = { login_id: "fixture", status: "pending", expires_in: 900, interval_ms: 1000 };
afterEach(() => { vi.useRealTimers(); });

describe("Codex login ownership", () => {
  it("rejects another window and keeps polling/cancellation on the original context", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(pending);
    const flow = new CodexLoginCoordinator(request);
    await flow.start(new Owner(1), context);
    await expect(flow.start(new Owner(2), otherContext)).rejects.toThrow("already running");
    await expect(flow.poll(2, "fixture")).rejects.toThrow("not found");
    await flow.poll(1, "fixture");
    expect(request).toHaveBeenLastCalledWith(context, "auth/codex/login/poll", { login_id: "fixture" });
    request.mockResolvedValueOnce({ ok: true });
    await flow.cancel(1, "fixture");
    expect(request).toHaveBeenLastCalledWith(context, "auth/codex/login/cancel", { login_id: "fixture" });
    await flow.start(new Owner(2), otherContext);
  });
  it("cancels if its owner closes before startup returns", async () => {
    vi.useFakeTimers();
    let resolveStart!: (value: AuthCodexLoginResult) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise<AuthCodexLoginResult>(resolve => { resolveStart = resolve; })).mockResolvedValue({ ok: true });
    const flow = new CodexLoginCoordinator(request);
    const owner = new Owner(1);
    const started = flow.start(owner, context);
    owner.destroy();
    resolveStart(pending);
    await started;
    expect(request).toHaveBeenLastCalledWith(context, "auth/codex/login/cancel", { login_id: "fixture" });
  });
  it("cancels a failed poll before admitting another login", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(pending).mockRejectedValueOnce(new Error("poll transport failed")).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(pending);
    const flow = new CodexLoginCoordinator(request);
    await flow.start(new Owner(1), context);
    await expect(flow.poll(1, "fixture")).rejects.toThrow("poll transport failed");
    expect(request).toHaveBeenLastCalledWith(context, "auth/codex/login/cancel", { login_id: "fixture" });
    await flow.start(new Owner(2), otherContext);
  });
  it("preserves the duplicate guard after poll and cleanup transport failures until expiry", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(pending).mockRejectedValue(new Error("transport failed"));
    const flow = new CodexLoginCoordinator(request);
    await flow.start(new Owner(1), context);
    await expect(flow.poll(1, "fixture")).rejects.toThrow("transport failed");
    await expect(flow.start(new Owner(2), otherContext)).rejects.toThrow("already running");
    await expect(flow.cancel(1, "fixture")).rejects.toThrow("transport failed");
    await expect(flow.start(new Owner(2), otherContext)).rejects.toThrow("already running");
    await vi.advanceTimersByTimeAsync(905_000);
    request.mockResolvedValueOnce(pending);
    await flow.start(new Owner(2), otherContext);
  });
  it("retains ownership after an uncertain startup response until the CLI lifetime ends", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(pending);
    const flow = new CodexLoginCoordinator(request);
    await expect(flow.start(new Owner(1), context)).rejects.toThrow("status is unknown");
    await expect(flow.start(new Owner(2), otherContext)).rejects.toThrow("already running");
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    await flow.start(new Owner(2), otherContext);
  });
  it("clears terminal ownership and startup failures without retaining listeners", async () => {
    vi.useFakeTimers();
    const owner = new Owner(1);
    const request = vi.fn().mockRejectedValueOnce(new AppServerResponseError("CLI missing")).mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, status: "success" });
    const flow = new CodexLoginCoordinator(request);
    await expect(flow.start(owner, context)).rejects.toThrow("CLI missing");
    expect(owner.listenerCount("destroyed")).toBe(0);
    await flow.start(owner, context);
    await flow.poll(1, "fixture");
    expect(owner.listenerCount("destroyed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
