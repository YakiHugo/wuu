import type { AuthCodexLoginResult, RuntimeContext } from "../shared/protocol";
import { AppServerResponseError } from "./appServerErrors";

type LoginWindow = {
  id: number;
  isDestroyed: () => boolean;
  once: (event: "destroyed", listener: () => void) => unknown;
  removeListener: (event: "destroyed", listener: () => void) => unknown;
};
type LoginRequest = (context: RuntimeContext, method: string, params?: { login_id: string }) => Promise<unknown>;
type LoginOwner = {
  loginID: string;
  senderID: number;
  context: RuntimeContext;
  dispose: () => void;
};

// The credential store is user-wide although each project has its own server.
// Ownership survives transport errors until cancellation or backend expiry.
export class CodexLoginCoordinator {
  private current: LoginOwner | undefined;
  constructor(private readonly request: LoginRequest) {}

  async start(window: LoginWindow, context: RuntimeContext): Promise<AuthCodexLoginResult> {
    if (this.current) throw new Error("A ChatGPT login is already running; finish or cancel it first.");
    const owner: LoginOwner = { loginID: "", senderID: window.id, context, dispose: () => {} };
    this.current = owner;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (!owner.loginID) return;
      void this.request(context, "auth/codex/login/cancel", { login_id: owner.loginID })
        .then(() => owner.dispose()).catch(() => {});
    };
    owner.dispose = () => {
      clearTimeout(expiry);
      window.removeListener("destroyed", cancel);
      if (this.current === owner) this.current = undefined;
    };
    window.once("destroyed", cancel);
    // If the start response is lost, there is no server-issued ID to cancel.
    // Allow the server's 15-minute process limit plus transport/shutdown margin.
    expiry = setTimeout(() => owner.dispose(), 16 * 60 * 1000);
    try {
      const result = await this.request(context, "auth/codex/login/start") as AuthCodexLoginResult;
      owner.loginID = result.login_id;
      clearTimeout(expiry);
      expiry = setTimeout(() => {
        cancel();
        // The backend enforces its own lifetime even if transport is broken.
        owner.dispose();
      }, (result.expires_in + 5) * 1000);
      if (window.isDestroyed()) cancel();
      if (result.status !== "pending") owner.dispose();
      return result;
    } catch (error) {
      if (error instanceof AppServerResponseError) {
        owner.dispose();
        throw error;
      }
      throw new Error("ChatGPT login status is unknown and it may still be running. Wait for it to expire, or close and restart Wuu before trying again.", { cause: error });
    }
  }

  async poll(senderID: number, loginID: string): Promise<AuthCodexLoginResult> {
    const owner = this.current;
    if (!owner || owner.loginID !== loginID || owner.senderID !== senderID) {
      throw new Error("ChatGPT login was not found; start again.");
    }
    try {
      const result = await this.request(owner.context, "auth/codex/login/poll", { login_id: loginID }) as AuthCodexLoginResult;
      if (result.status !== "pending") owner.dispose();
      return result;
    } catch (error) {
      // A failed poll does not mean the login process stopped.
      try {
        await this.request(owner.context, "auth/codex/login/cancel", { login_id: loginID });
        owner.dispose();
      } catch { /* The expiry timer retains responsibility for cleanup. */ }
      throw error;
    }
  }

  async cancel(senderID: number, loginID: string): Promise<{ ok: boolean }> {
    const owner = this.current;
    if (!owner || owner.loginID !== loginID || owner.senderID !== senderID) return { ok: true };
    const result = await this.request(owner.context, "auth/codex/login/cancel", { login_id: loginID }) as { ok: boolean };
    owner.dispose();
    return result;
  }
}
