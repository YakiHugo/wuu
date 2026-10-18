import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineListResult } from "../shared/protocol";
import { DefaultEngineRow, EngineSettingsSection } from "./EngineSettingsSection";

const inventory: EngineListResult = {
  engines: [
    { id: "wuu", enabled: true, binary_ok: true },
    { id: "codex", enabled: true, binary_ok: true },
    { id: "claude", enabled: true, binary_ok: true },
  ],
  settings: { default_engine: "wuu" },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.wuu = { ...window.wuu, listEngines: vi.fn().mockResolvedValue(inventory) };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function defaultPicker(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="settings-default-engine"]')!;
}

async function openDefaultPicker(): Promise<HTMLButtonElement[]> {
  await act(async () => defaultPicker().click());
  return [...document.querySelectorAll<HTMLButtonElement>(".select-menu-item")];
}

// The default picker lives on the General page and the agent list on the
// Agents page; both read and write the same inventory.
function render(result: EngineListResult | undefined, onUpdate = vi.fn(), onRefresh = vi.fn()) {
  act(() => {
    root.render(
      <>
        <DefaultEngineRow result={result} onUpdate={onUpdate} />
        <EngineSettingsSection
          result={result}
          onRefresh={onRefresh}
          onUpdate={onUpdate}
        />
      </>,
    );
  });
  return { onUpdate, onRefresh };
}

describe("EngineSettingsSection", () => {
  it("saves defaults and disables engines discovered outside the native pair", async () => {
    const live: EngineListResult = {
      engines: [{ id: "devin", display_name: "Devin", enabled: true, binary_ok: true }],
      settings: { devin: { binary_path: "/opt/devin" } },
    };
    const onUpdate = vi.fn().mockResolvedValue(live);
    render(live, onUpdate);
    const devin = (await openDefaultPicker()).find((item) => item.dataset.value === "devin")!;
    await act(async () => devin.click());
    expect(onUpdate).toHaveBeenLastCalledWith({ default_engine: "devin" });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="settings-engine-devin-status"]')!.click());
    expect(document.querySelector<HTMLInputElement>('[data-testid="settings-engine-devin-path"]')!.value).toBe("/opt/devin");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-engine-devin-enabled"]')!.click());
    expect(onUpdate).toHaveBeenLastCalledWith({ devin: { enabled: false } });
  });

  it("renders a supplied session snapshot without starting detection on mount", () => {
    const onRefresh = vi.fn();
    render(inventory, vi.fn(), onRefresh);

    expect(defaultPicker().textContent).toContain("Wuu");
    expect(container.querySelector('[data-testid="settings-engine-codex-status"]')?.getAttribute("aria-label")).toContain("已就绪");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("keeps the cached snapshot visible while the user explicitly refreshes", async () => {
    let resolveRefresh: ((value: EngineListResult) => void) | undefined;
    const onRefresh = vi.fn(() => new Promise<EngineListResult>((resolve) => {
      resolveRefresh = resolve;
    }));
    render(inventory, vi.fn(), onRefresh);

    const refresh = container.querySelector<HTMLButtonElement>('[data-testid="settings-engine-refresh"]')!;
    await act(async () => {
      refresh.click();
    });

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(refresh.disabled).toBe(true);
    expect(defaultPicker()).not.toBeNull();

    await act(async () => {
      resolveRefresh?.(inventory);
    });
    expect(refresh.disabled).toBe(false);
  });

  it("uses a stable skeleton only when no session snapshot exists", () => {
    render(undefined);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(defaultPicker().disabled).toBe(true);
    expect(container.querySelector('[data-testid="settings-engine-refresh"]')).not.toBeNull();
  });

  it("hides absent default-enabled catalog engines and keeps them out of the default picker", async () => {
    const missingClaude: EngineListResult = {
      engines: [
        { id: "wuu", enabled: true, binary_ok: true },
        { id: "codex", enabled: true, binary_ok: true },
        { id: "claude", enabled: true, binary_ok: false },
      ],
      settings: { default_engine: "wuu" },
    };
    render(missingClaude);

    const options = await openDefaultPicker();
    expect(options.map((item) => item.dataset.value)).toEqual(["wuu", "codex"]);
    expect(container.querySelector('[data-testid="settings-engine-claude-status"]')).toBeNull();
  });

  it("lists a switched-off agent in the default picker without letting it be picked", async () => {
    const onUpdate = vi.fn();
    render({
      engines: [
        { id: "wuu", enabled: true, binary_ok: true },
        { id: "codex", enabled: false, binary_ok: true },
      ],
      settings: { default_engine: "wuu", codex: { enabled: false } },
    }, onUpdate);

    const codex = (await openDefaultPicker()).find((item) => item.dataset.value === "codex")!;
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain("已停用");
    await act(async () => codex.click());
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("shows a detected binary path only in the override field", async () => {
    const path = "/opt/claude/bin/claude";
    render({
      engines: [{ id: "claude", enabled: true, binary_ok: true, binary_path: path }],
      settings: { default_engine: "wuu" },
    });

    const row = container.querySelector('[data-testid="settings-engine-claude-status"]')!;
    expect(row.getAttribute("aria-label")).toContain("已就绪");
    expect(row.textContent).not.toContain(path);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-engine-claude-status"]')!.click();
    });
    expect(document.querySelector<HTMLInputElement>('[data-testid="settings-engine-claude-path"]')?.placeholder).toBe(path);
    expect(row.querySelector(".settings-engine-detail")).toBeNull();
  });

  it("keeps a configured missing engine recoverable and retains its drawer after disabling", async () => {
    let current: EngineListResult = {
      engines: [{ id: "codex", enabled: false, binary_ok: false }],
      settings: { codex: { enabled: true, binary_path: "/missing/codex" } },
    };
    const onUpdate = vi.fn(async () => {
      current = { ...current, settings: { codex: { enabled: false, binary_path: "/missing/codex" } } };
      render(current, onUpdate);
      return current;
    });
    render(current, onUpdate);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="settings-engine-codex-status"]')!.click());
    expect(window.wuu.listEngines).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-engine-codex-enabled"]')!.click());
    expect(container.querySelector('[data-testid="settings-engine-codex-status"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="subscription-engine-codex"]')).not.toBeNull();
  });

  it("opens a hidden catalog engine by selection and retains a failed path draft for retry", async () => {
    const missing: EngineListResult = { engines: [{ id: "codex", enabled: false, binary_ok: false }] };
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error("Cannot save path")).mockResolvedValue(missing);
    await act(async () => root.render(<EngineSettingsSection result={missing} embedded selectedEngineID="codex" onUpdate={onUpdate} onRefresh={vi.fn()} />));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('[data-testid="settings-engine-codex-path"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/custom/codex");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onUpdate).not.toHaveBeenCalled();
    const save = document.querySelector<HTMLButtonElement>('[data-testid="settings-engine-codex-path-save"]')!;
    await act(async () => save.click());
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("Cannot save path");
    expect(input.value).toBe("/custom/codex");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith({ codex: { binary_path: "/custom/codex" } });
  });

});
