import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChatGPTConnectionDialog } from "./ChatGPTConnectionDialog";

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); });
it("requires an account-bound model before saving and preserves the returned order", async () => {
  let resolveModels!: (value: unknown) => void;
  const save = vi.fn().mockResolvedValue(undefined);
  const models = vi.fn().mockReturnValue(new Promise(resolve => { resolveModels = resolve; }));
  vi.stubGlobal("wuu", {
    listChatGPTAccounts: vi.fn().mockResolvedValue({ accounts: [{ id: "account-a", email: "a@example.test", status: "connected" }] }),
    listChatGPTModels: models,
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<ChatGPTConnectionDialog providers={[]} running={false} defaultOn={false} onSave={save} onClose={vi.fn()} onConnected={vi.fn()} />));
  const connect = () => document.querySelector<HTMLButtonElement>('[data-testid="settings-provider-connect"]')!;
  expect(connect().disabled).toBe(true);
  expect(models).toHaveBeenCalledWith("account-a");
  await act(async () => resolveModels({ models: [{ id: "z-model", name: "First recommended" }, { id: "a-model", name: "Second" }] }));
  expect(connect().disabled).toBe(false);
  await act(async () => connect().click());
  expect(save).toHaveBeenCalledWith("chatgpt", "z-model", undefined, { type: "chatgpt", create_provider: true, chatgpt_account_id: "account-a", keep_selection: true });
});
