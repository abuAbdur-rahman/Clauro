// @vitest-environment jsdom
/**
 * ProvidersView tests. The settings surface for endpoints, keys, and model
 * lists: card parity (logo-initials, masked key, status pill, enable
 * switch, Edit/Test/Delete), the add/edit dialog (type autofill that never
 * wipes a custom URL, chips, real Fetch/Test, zod-gated Save), and a
 * dismissable delete confirm.
 *
 * The bridge is mocked — these pin the view's behaviour, including the
 * rules that never weaken: the stored key is never echoed (Replace-key
 * input only), and a rejected key shows a notice while the host rolls the
 * key back, leaving the provider keyless.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvidersView } from "./ProvidersView";
import type { ModelsView, ProviderView } from "./providers";

vi.mock("./providers", () => ({
  providerList: vi.fn(),
  providerAddBuiltin: vi.fn(),
  providerAddCustom: vi.fn(),
  providerRemove: vi.fn(),
  providerSetKey: vi.fn(),
  providerRefresh: vi.fn(),
  providerModels: vi.fn(),
  PROVIDER_PRESETS: {
    openai: { label: "OpenAI", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
    anthropic: { label: "Anthropic", name: "Anthropic", baseUrl: "" },
    openrouter: { label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
    ollama: { label: "Ollama (local)", name: "Ollama (local)", baseUrl: "http://localhost:11434" },
    custom: { label: "Custom (OpenAI-compatible)", name: "", baseUrl: "" },
  },
  ProviderFormSchema: {
    safeParse: (raw: unknown): { success: boolean } => {
      if (typeof raw !== "object" || raw === null) return { success: false };
      const rec = raw as Record<string, unknown>;
      const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
      const url = typeof rec["baseUrl"] === "string" ? rec["baseUrl"].trim() : "";
      const key = typeof rec["key"] === "string" ? rec["key"] : "";
      const type = rec["type"];
      if (name === "") return { success: false };
      if (type !== "anthropic" && !/^https?:\/\/.+/i.test(url)) return { success: false };
      if (type !== "ollama" && key.trim() === "" && key !== "keep-existing-key") {
        return { success: false };
      }
      return { success: true };
    },
  },
  isProviderFormValid: (raw: unknown, opts?: { allowBlankKey?: boolean }): boolean => {
    if (typeof raw !== "object" || raw === null) return false;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
    const url = typeof rec["baseUrl"] === "string" ? rec["baseUrl"].trim() : "";
    const key = typeof rec["key"] === "string" ? rec["key"] : "";
    if (name === "") return false;
    if (rec["type"] !== "anthropic" && !/^https?:\/\/.+/i.test(url)) return false;
    if (key.trim() === "") {
      if (rec["type"] === "ollama") return true;
      return opts?.allowBlankKey === true;
    }
    return true;
  },
  slugifyProviderId: (name: string): string => {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug === "" ? "custom" : slug;
  },
}));

import {
  providerAddBuiltin,
  providerAddCustom,
  providerList,
  providerModels,
  providerRefresh,
  providerRemove,
  providerSetKey,
} from "./providers";

function row(over: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "anthropic",
    display_name: "Anthropic",
    kind: "anthropic",
    base_url: null,
    model_count: 2,
    models_fetched_at: 1000,
    stale: false,
    has_key: true,
    ...over,
  };
}

function modelsView(id: string, ids: string[] = ["claude-x", "claude-y"]): ModelsView {
  return {
    provider_id: id,
    models: ids.map((m) => ({ id: m, display_name: m })),
    models_fetched_at: 2000,
    stale: false,
  };
}

function inputByTestId(id: string): HTMLInputElement {
  const el = screen.getByTestId(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`expected an input: ${id}`);
  return el;
}

function buttonByTestId(id: string): HTMLButtonElement {
  const el = screen.getByTestId(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`expected a button: ${id}`);
  return el;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ProvidersView cards", () => {
  it("renders the empty state when nothing is configured", async () => {
    vi.mocked(providerList).mockResolvedValue([]);
    render(<ProvidersView />);
    await waitFor(() => {
      expect(screen.getByText(/no providers/i)).toBeTruthy();
    });
    expect(screen.getByTestId("provider-add")).toBeTruthy();
  });

  it("card shows initials, base URL, masked key, untested pill, switch, and actions", async () => {
    vi.mocked(providerList).mockResolvedValue([
      row(),
      row({
        id: "office",
        display_name: "Office gateway",
        kind: "openai-compatible",
        base_url: "https://llm.office.example/v1",
        model_count: 0,
        models_fetched_at: null,
        stale: true,
        has_key: false,
      }),
    ]);
    render(<ProvidersView />);
    const card = await screen.findByTestId("provider-card-office");
    expect(within(card).getByText("Office gateway")).toBeTruthy();
    expect(within(card).getByText("https://llm.office.example/v1")).toBeTruthy();
    // Masked, never echoed: the real key text must not appear anywhere.
    expect(within(card).getByText("No key")).toBeTruthy();
    expect(screen.getByTestId("provider-key-anthropic").textContent).toBe("••••••••");
    expect(document.body.textContent).not.toContain("sk-live");
    expect(screen.getByTestId("provider-status-office").textContent).toBe("Untested");
    expect(screen.getByTestId("provider-enable-office").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("provider-edit-office")).toBeTruthy();
    expect(screen.getByTestId("provider-test-office")).toBeTruthy();
    expect(screen.getByTestId("provider-delete-office")).toBeTruthy();
  });

  it("enable switch toggles and persists", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row()]);
    render(<ProvidersView />);
    const toggle = await screen.findByTestId("provider-enable-anthropic");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("Test proves the key live: pill flips, notice shows count and latency", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row()]);
    vi.mocked(providerRefresh).mockResolvedValue(modelsView("anthropic"));
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-test-anthropic"));
    await waitFor(() => {
      expect(providerRefresh).toHaveBeenCalledWith("anthropic");
    });
    await waitFor(() => {
      expect(screen.getByTestId("provider-status-anthropic").textContent).toBe("Connected");
    });
    expect(screen.getByRole("status").textContent).toMatch(/connected · 2 models · \d+ms/i);
  });

  it("a failed Test is honest: Error pill plus the refusal reason", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row()]);
    vi.mocked(providerRefresh).mockRejectedValue(new Error("provider refused the key"));
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-test-anthropic"));
    await waitFor(() => {
      expect(screen.getByTestId("provider-status-anthropic").textContent).toBe("Error");
    });
    expect(screen.getByText(/provider refused the key/i)).toBeTruthy();
  });

  it("delete confirms in-dialog and both buttons dismiss", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row()]);
    vi.mocked(providerRemove).mockResolvedValue(true);
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-delete-anthropic"));
    const confirm = await screen.findByTestId("provider-delete-confirm");
    expect(within(confirm).getAllByText(/anthropic/i).length).toBeGreaterThan(0);
    // Cancel dismisses without calling through.
    await user.click(screen.getByTestId("provider-delete-confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("provider-delete-confirm")).toBeNull();
    });
    expect(providerRemove).not.toHaveBeenCalled();
    // Reopen and confirm for real.
    await user.click(screen.getByTestId("provider-delete-anthropic"));
    await screen.findByTestId("provider-delete-confirm");
    await user.click(screen.getByTestId("provider-delete-confirm-ok"));
    await waitFor(() => {
      expect(providerRemove).toHaveBeenCalledWith("anthropic");
    });
    expect(providerList).toHaveBeenCalledTimes(2);
  });
});

describe("ProvidersView add dialog", () => {
  async function openAdd(): Promise<void> {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([]);
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-add"));
    await screen.findByTestId("provider-dialog");
  }

  it("type select autofills name and URL", async () => {
    const user = userEvent.setup();
    await openAdd();
    const type = screen.getByTestId("provider-dialog-type");
    await user.selectOptions(type, "openrouter");
    expect(inputByTestId("provider-dialog-name").value).toBe(
      "OpenRouter",
    );
    expect(inputByTestId("provider-dialog-url").value).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("never wipes a custom URL unless pristine", async () => {
    const user = userEvent.setup();
    await openAdd();
    await user.selectOptions(screen.getByTestId("provider-dialog-type"), "custom");
    const url = inputByTestId("provider-dialog-url");
    await user.type(url, "https://llm.office.example/v1");
    await user.selectOptions(screen.getByTestId("provider-dialog-type"), "openai");
    // The user's own URL survives the type switch.
    expect(inputByTestId("provider-dialog-url").value).toBe(
      "https://llm.office.example/v1",
    );
  });

  it("Save stays disabled until the form is valid", async () => {
    const user = userEvent.setup();
    await openAdd();
    await user.selectOptions(screen.getByTestId("provider-dialog-type"), "custom");
    const save = buttonByTestId("provider-dialog-save");
    expect(save.disabled).toBe(true);
    await user.type(screen.getByTestId("provider-dialog-name"), "Office");
    await user.type(screen.getByTestId("provider-dialog-url"), "not-a-url");
    await user.type(screen.getByTestId("provider-dialog-key"), "sk-x");
    expect(save.disabled).toBe(true);
    await user.tripleClick(screen.getByTestId("provider-dialog-url"));
    await user.paste("https://llm.office.example/v1");
    await waitFor(() => {
      expect(buttonByTestId("provider-dialog-save").disabled).toBe(
        false,
      );
    });
  }, 20000);

  it("saving a builtin adds it then proves the key live", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([]);
    vi.mocked(providerAddBuiltin).mockResolvedValue(row({ id: "openai", display_name: "OpenAI" }));
    vi.mocked(providerSetKey).mockResolvedValue(modelsView("openai"));
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-add"));
    await screen.findByTestId("provider-dialog");
    await user.selectOptions(screen.getByTestId("provider-dialog-type"), "openai");
    await user.type(screen.getByTestId("provider-dialog-key"), "sk-live");
    await user.click(screen.getByTestId("provider-dialog-save"));
    await waitFor(() => {
      expect(providerAddBuiltin).toHaveBeenCalledWith("openai");
    });
    expect(providerSetKey).toHaveBeenCalledWith("openai", "sk-live");
    await waitFor(() => {
      expect(screen.queryByTestId("provider-dialog")).toBeNull();
    });
  });

  it("saving a custom endpoint sends a derived id and its URL", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([]);
    vi.mocked(providerAddCustom).mockResolvedValue(
      row({ id: "office-gateway", display_name: "Office gateway" }),
    );
    vi.mocked(providerSetKey).mockResolvedValue(modelsView("office-gateway"));
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-add"));
    await screen.findByTestId("provider-dialog");
    await user.selectOptions(screen.getByTestId("provider-dialog-type"), "custom");
    await user.type(screen.getByTestId("provider-dialog-name"), "Office gateway");
    await user.click(screen.getByTestId("provider-dialog-url"));
    await user.paste("https://llm.office.example/v1");
    await user.type(screen.getByTestId("provider-dialog-key"), "sk-live");
    await user.click(screen.getByTestId("provider-dialog-save"));
    await waitFor(() => {
      expect(providerAddCustom).toHaveBeenCalledWith({
        id: "office-gateway",
        displayName: "Office gateway",
        baseUrl: "https://llm.office.example/v1",
      });
    });
  });

  it("a rejected key on save shows the refusal and keeps the dialog open", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([]);
    vi.mocked(providerAddBuiltin).mockResolvedValue(row({ id: "openai", display_name: "OpenAI" }));
    // The host rolls the bad key back; the row stays keyless and the notice
    // says why — the dialog stays open so the key can be fixed.
    vi.mocked(providerSetKey).mockRejectedValue(new Error("provider refused the key"));
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-add"));
    await screen.findByTestId("provider-dialog");
    await user.selectOptions(screen.getByTestId("provider-dialog-type"), "openai");
    await user.type(screen.getByTestId("provider-dialog-key"), "sk-bad");
    await user.click(screen.getByTestId("provider-dialog-save"));
    await waitFor(() => {
      expect(screen.getAllByText(/provider refused the key/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("provider-dialog")).toBeTruthy();
  });
});

describe("ProvidersView edit dialog", () => {
  async function openEdit(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row()]);
    vi.mocked(providerModels).mockResolvedValue(modelsView("anthropic"));
    render(<ProvidersView />);
    await user.click(await screen.findByTestId("provider-edit-anthropic"));
    await screen.findByTestId("provider-dialog");
    return user;
  }

  it("shows stored fields with a blank Replace-key input — never the stored key", async () => {
    await openEdit();
    expect(inputByTestId("provider-dialog-name").value).toBe(
      "Anthropic",
    );
    const key = inputByTestId("provider-dialog-key");
    expect(key.value).toBe("");
    expect(key.placeholder).toMatch(/replace/i);
    expect(key.type).toBe("password");
    expect(document.body.textContent).not.toContain("sk-live");
  });

  it("eye toggle reveals the replacement while typing", async () => {
    const user = await openEdit();
    const key = inputByTestId("provider-dialog-key");
    await user.type(key, "sk-new");
    await user.click(screen.getByTestId("provider-dialog-eye"));
    expect(inputByTestId("provider-dialog-key").type).toBe("text");
  });

  it("Fetch loads the stored models as removable chips, add/remove edits the list", async () => {
    const user = await openEdit();
    await user.click(screen.getByTestId("provider-dialog-fetch"));
    await waitFor(() => {
      expect(providerModels).toHaveBeenCalledWith("anthropic");
    });
    expect(await screen.findByText("claude-x")).toBeTruthy();
    await user.type(screen.getByTestId("provider-dialog-model-input"), "claude-z");
    await user.click(screen.getByTestId("provider-dialog-model-add"));
    expect(screen.getByText("claude-z")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /remove claude-x/i }));
    expect(screen.queryByText("claude-x")).toBeNull();
  });

  it("Test proves live and shows the connected count; key edits reset to untested", async () => {
    const user = await openEdit();
    vi.mocked(providerRefresh).mockResolvedValue(modelsView("anthropic"));
    await user.click(screen.getByTestId("provider-dialog-test"));
    await waitFor(() => {
      expect(screen.getByTestId("provider-dialog-status").textContent).toBe("Connected");
    });
    expect(screen.getByText(/connected · 2 models/i)).toBeTruthy();
    // Touching the key invalidates the proof.
    await user.type(screen.getByTestId("provider-dialog-key"), "sk-other");
    expect(screen.getByTestId("provider-dialog-status").textContent).toBe("Untested");
  });

  it("saving a replacement key proves it live and closes", async () => {
    const user = await openEdit();
    vi.mocked(providerSetKey).mockResolvedValue(modelsView("anthropic"));
    await user.type(screen.getByTestId("provider-dialog-key"), "sk-new");
    await user.click(screen.getByTestId("provider-dialog-save"));
    await waitFor(() => {
      expect(providerSetKey).toHaveBeenCalledWith("anthropic", "sk-new");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("provider-dialog")).toBeNull();
    });
  });

  it("saving with no key change is honest about host limits and stays open", async () => {
    const user = await openEdit();
    await user.click(screen.getByTestId("provider-dialog-save"));
    await waitFor(() => {
      expect(screen.getByText(/no rename endpoint/i)).toBeTruthy();
    });
    expect(providerSetKey).not.toHaveBeenCalled();
    expect(screen.getByTestId("provider-dialog")).toBeTruthy();
  });
});
