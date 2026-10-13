// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ModelPicker from "./ModelPicker";
import { useThreadStore } from "../features/catalogue/thread";
import { invalidateModelEntries } from "../features/providers/modelEntries";
import type { EnrichedModel } from "../features/providers/providers";

/**
 * Model picker on shadcn Select (Task 025, D112) — sourced from configured
 * providers, not the bulk catalogue. The bridge is mocked; these pin grouping,
 * limits display, the unknown-limits refusal, and thread writes.
 */

// Radix Select needs these in jsdom.
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {};
window.HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
  return false;
};
window.HTMLElement.prototype.setPointerCapture = function setPointerCapture(): void {};
window.HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(): void {};

vi.mock("../features/providers/providers", () => ({
  providerList: vi.fn(),
  providerModelsEnriched: vi.fn(),
}));

import { providerList, providerModelsEnriched } from "../features/providers/providers";

const THREAD = "picker-t1";

function known(id: string, name: string): EnrichedModel {
  return {
    id,
    display_name: name,
    limits_known: true,
    context_window: 200000,
    max_output: 8192,
    reasoning: false,
    tool_call: true,
  };
}

function unknown(id: string): EnrichedModel {
  return {
    id,
    display_name: id,
    limits_known: false,
    context_window: null,
    max_output: null,
    reasoning: false,
    tool_call: false,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Prefs are global (Settings → Models writes them) and so is the shared
  // load: both must be pristine or one test's answers leak into the next.
  localStorage.clear();
  invalidateModelEntries();
  useThreadStore.getState().reset();
  useThreadStore.getState().openThread(THREAD);
  vi.mocked(providerList).mockResolvedValue([
    {
      id: "anthropic",
      display_name: "Anthropic",
      kind: "anthropic",
      base_url: null,
      model_count: 2,
      models_fetched_at: 1000,
      stale: false,
      has_key: true,
    },
  ]);
  vi.mocked(providerModelsEnriched).mockResolvedValue([known("claude-haiku-4-5", "Haiku")]);
});

describe("ModelPicker on Select", () => {
  it("renders a select trigger with a placeholder when no model is chosen", async () => {
    render(<ModelPicker threadId={THREAD} />);
    expect(await screen.findByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("combobox").textContent).toMatch(/choose a model/i);
  });

  it("the compact trigger is a chip whose label truncates (T7)", async () => {
    // Task 031 T7, matching the reference's `.ctools .chip` (docs/references/
    // ui/index.html:141,441): the composer's model control is a bordered 28px
    // chip whose label truncates at 260px, rather than a box that grows with
    // the model name. The full-width picker (Settings → Models) keeps its own
    // shape, and the chevron is the SelectTrigger's own — a chip that drew its
    // own would render two.
    const { unmount } = render(<ModelPicker threadId={THREAD} compact />);
    const chip = await screen.findByRole("combobox");
    expect(chip.getAttribute("data-testid")).toBe("model-chip");
    const label = chip.querySelector('[data-testid="model-chip-label"]');
    expect(label).not.toBeNull();
    expect(label?.className).toMatch(/truncate/);
    expect(chip.querySelectorAll("svg")).toHaveLength(1);
    unmount();

    render(<ModelPicker threadId={THREAD} />);
    expect((await screen.findByRole("combobox")).getAttribute("data-testid")).toBe(
      "model-picker",
    );
  });

  it("opens provider-grouped options carrying limits", async () => {
    const user = userEvent.setup();
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const groups = within(listbox).getAllByRole("group");
    expect(groups).toHaveLength(1);
    expect(within(listbox).getByRole("option", { name: /haiku/i })).not.toBeNull();
    expect(within(listbox).getByText(/200k ctx/i)).not.toBeNull();
  });

  it("choosing an option writes thread-level state and the thread stays open", async () => {
    const user = userEvent.setup();
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    const option = await screen.findByRole("option", { name: /haiku/i });
    await user.click(option);
    const thread = useThreadStore.getState().threads[THREAD];
    expect(thread?.open).toBe(true);
    expect(thread?.model?.provider).toBe("anthropic");
    expect(thread?.model?.id).toBe("claude-haiku-4-5");
    expect(screen.getByRole("combobox").textContent).toMatch(/haiku/i);
  });

  it("shows each configured provider's models and nothing else", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([
      {
        id: "anthropic",
        display_name: "Anthropic",
        kind: "anthropic",
        base_url: null,
        model_count: 1,
        models_fetched_at: 1000,
        stale: false,
        has_key: true,
      },
      {
        id: "office",
        display_name: "Office gateway",
        kind: "openai-compatible",
        base_url: "https://llm.office.example/v1",
        model_count: 1,
        models_fetched_at: 1000,
        stale: false,
        has_key: true,
      },
    ]);
    vi.mocked(providerModelsEnriched).mockImplementation((id: string) =>
      Promise.resolve(id === "office" ? [known("desk-1", "Desk 1")] : [known("claude-haiku-4-5", "Haiku")]),
    );
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("group")).toHaveLength(2);
    expect(providerModelsEnriched).toHaveBeenCalledWith("anthropic");
    expect(providerModelsEnriched).toHaveBeenCalledWith("office");
  });

  it("a model with unknown limits cannot be selected", async () => {
    const user = userEvent.setup();
    vi.mocked(providerModelsEnriched).mockResolvedValue([unknown("mystery-1")]);
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    const option = await screen.findByRole("option", { name: /mystery-1/i });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(useThreadStore.getState().threads[THREAD]?.model).toBeNull();
  });

  it("no configured providers renders the honest-empty notice, not a crash", async () => {
    vi.mocked(providerList).mockResolvedValue([]);
    render(<ModelPicker threadId={THREAD} />);
    expect(await screen.findByText(/no providers configured/i)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("filters options through the search input without losing grouping", async () => {
    const user = userEvent.setup();
    vi.mocked(providerModelsEnriched).mockResolvedValue([
      known("claude-haiku-4-5", "Haiku"),
      known("claude-opus-4-5", "Opus"),
    ]);
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    await screen.findByRole("listbox");
    await user.type(screen.getByLabelText(/search models/i), "opus");
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByRole("option", { name: /opus/i })).not.toBeNull();
    expect(within(listbox).queryByRole("option", { name: /haiku/i })).toBeNull();
  });
});

describe("one shared load for every mounted picker (review 32 startup perf)", () => {
  it("two mounts trigger ONE provider list and ONE enrichment per provider", async () => {
    render(
      <>
        <ModelPicker threadId={THREAD} />
        <ModelPicker threadId={THREAD} compact />
      </>,
    );
    expect((await screen.findAllByRole("combobox")).length).toBe(2);
    expect(providerList).toHaveBeenCalledTimes(1);
    expect(providerModelsEnriched).toHaveBeenCalledTimes(1);
  });
});

describe("keyboard reach into the Select (review 32 / 61 a11y)", () => {
  it("Escape still closes the picker after a filter character", async () => {
    const user = userEvent.setup();
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    await screen.findByRole("listbox");
    await user.type(screen.getByLabelText(/search models/i), "h");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("arrow keys and Enter reach the Select from inside the filter box", async () => {
    const user = userEvent.setup();
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    await screen.findByRole("listbox");
    const box = screen.getByLabelText(/search models/i);
    await user.click(box);
    await user.type(box, "hai");
    // ArrowDown escapes the input (the trap's position): Radix moves real DOM
    // focus onto an option. Pre-fix the blanket stopPropagation kept it here.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("role")).toBe("option");
    // Back up onto the model, then commit it with Enter — both keys, one path.
    await user.keyboard("{ArrowUp}{Enter}");
    expect(useThreadStore.getState().threads[THREAD]?.model?.id).toBe("claude-haiku-4-5");
    expect(screen.queryByRole("listbox")).toBeNull();
  }, 30000);

  it("Enter in the filter selects the matching model", async () => {
    const user = userEvent.setup();
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    await screen.findByRole("listbox");
    await user.type(screen.getByLabelText(/search models/i), "hai");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox").textContent).toMatch(/haiku/i);
    expect(useThreadStore.getState().threads[THREAD]?.model?.id).toBe("claude-haiku-4-5");
  });
});

describe("pref readers (review 30/31 owner TODO)", () => {
  it("clauro.models.hidden keeps a hidden model out of the list", async () => {
    localStorage.setItem(
      "clauro.models.hidden",
      JSON.stringify({ "anthropic:claude-haiku-4-5": true }),
    );
    vi.mocked(providerModelsEnriched).mockResolvedValue([
      known("claude-haiku-4-5", "Haiku"),
      known("claude-opus-4-5", "Opus"),
    ]);
    const user = userEvent.setup();
    render(<ModelPicker threadId={THREAD} />);
    await user.click(await screen.findByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).queryByRole("option", { name: /haiku/i })).toBeNull();
    expect(within(listbox).getByRole("option", { name: /opus/i })).not.toBeNull();
  });

  it("clauro.prefs.defaultModel selects the stored model for a model-less thread", async () => {
    localStorage.setItem("clauro.prefs.defaultModel", "anthropic:claude-haiku-4-5");
    render(<ModelPicker threadId={THREAD} />);
    expect(await screen.findByRole("combobox")).toBeTruthy();
    await vi.waitFor(() => {
      expect(screen.getByRole("combobox").textContent).toMatch(/haiku/i);
    });
    expect(useThreadStore.getState().threads[THREAD]?.model?.id).toBe("claude-haiku-4-5");
  });
});
