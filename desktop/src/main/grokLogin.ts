import type { EngineAuthResult } from "../shared/protocol";

type Request = (method: string, params?: unknown) => Promise<unknown>;
type Owner = {
  id: number;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
};

/** A CLI login belongs to the window and process that started it, even after
 * a workspace switch. Grok's credential file is shared across workspaces. */
export class GrokLogin {
  private current?: { owner: number; request: Request; cancellation?: Promise<{ ok: boolean }> };

  get active(): boolean { return this.current !== undefined; }

  async start(owner: Owner, bind: () => Request): Promise<EngineAuthResult> {
    if (this.current) throw new Error("A Grok CLI sign-in is already running");
    const attempt = { owner: owner.id, request: bind() };
    this.current = attempt;
    const destroyed = () => {
      void this.cancel(owner.id).catch(() => {
        console.warn("Grok sign-in cancellation could not reach its original service");
      });
    };
    owner.once("destroyed", destroyed);
    try {
      return await attempt.request("engine/authenticate", { engine_id: "grok", method_id: "local-cli" }) as EngineAuthResult;
    } finally {
      owner.removeListener("destroyed", destroyed);
      this.current = undefined;
    }
  }

  cancel(owner: number): Promise<{ ok: boolean }> {
    const attempt = this.current;
    if (!attempt || attempt.owner !== owner) return Promise.resolve({ ok: false });
    return attempt.cancellation ??= attempt.request("engine/auth/cancel", { engine_id: "grok" }) as Promise<{ ok: boolean }>;
  }
}
