import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WuuDesktopApi } from "../shared/protocol";
import { ModelServicesPage } from "./ModelServicesPage";

it("allows offline configured Grok model changes without promoting the connection to default", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const previous = window.wuu;
  window.wuu = { listEngines: vi.fn().mockResolvedValue({ engines: [] }) } as unknown as WuuDesktopApi;
  const onSave = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<ModelServicesPage
      initialized={{ protocol_version: "wuu-app-server/v0.1", workspace_root: "/tmp/project", provider: "local", model: "local-model", providers: [
        { name: "grok", type: "grok-build", model: "grok-4.5", api_key_configured: false, models: [{ id: "grok-4.5" }, { id: "grok-4.6" }] },
      ] }} running={false} runningProviderNames={new Set()} onSave={onSave}
      onRemoveProvider={vi.fn()} onRefreshModelCatalog={vi.fn()} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="settings-provider-card"]')!.click());
    const model = container.querySelector<HTMLButtonElement>('[data-testid="settings-provider-model"][data-model="grok-4.6"]')!;
    expect(model).not.toBeNull();
    expect(model.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="settings-provider-add-model-open"]')!.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="settings-provider-remove-model"]')!.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="settings-provider-make-default"]')!.disabled).toBe(true);
    await act(async () => model.click());
    expect(onSave).toHaveBeenCalledWith("grok", "grok-4.6", undefined, { keep_selection: true });
  } finally {
    act(() => root.unmount());
    container.remove();
    window.wuu = previous;
  }
});
