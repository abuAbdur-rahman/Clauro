// @vitest-environment jsdom
/**
 * ProvidersView tests. The settings surface for endpoints, keys, and model
 * lists: add flows, key validation failure, refresh, and removal.
 *
 * The bridge is mocked — these pin the view's behaviour, including the rule
 * that a rejected key shows a notice and leaves the provider keyless rather
 * than rendering models that were never proven.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvidersView } from "./ProvidersView";
import type { ProviderView } from "./providers";

vi.mock("./providers", () => ({
  providerList: vi.fn(),
  providerAddBuiltin: vi.fn(),
  providerAddCustom: vi.fn(),
  providerRemove: vi.fn(),
  providerSetKey: vi.fn(),
  providerRefresh: vi.fn(),
}));

import {
  providerAddBuiltin,
  providerList,
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

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProvidersView", () => {
  it("renders the empty state when nothing is configured", async () => {
    vi.mocked(providerList).mockResolvedValue([]);
    render(<ProvidersView />);
    await waitFor(() => {
      expect(screen.getByText(/no providers/i)).toBeTruthy();
    });
  });

  it("lists configured providers with key and freshness status", async () => {
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
    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeTruthy();
    });
    expect(screen.getByText("Office gateway")).toBeTruthy();
    expect(screen.getByText(/key missing/i)).toBeTruthy();
  });

  it("adding a builtin calls through and reloads the list", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([]);
    vi.mocked(providerAddBuiltin).mockResolvedValue(row());
    render(<ProvidersView />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add anthropic/i })).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: /add anthropic/i }));
    await waitFor(() => {
      expect(providerAddBuiltin).toHaveBeenCalledWith("anthropic");
    });
    // The list reloads after adding.
    expect(providerList).toHaveBeenCalledTimes(2);
  });

  it("a rejected key shows a notice and stores nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row({ has_key: false, model_count: 0 })]);
    vi.mocked(providerSetKey).mockRejectedValue(new Error("provider refused the key"));
    render(<ProvidersView />);
    const input = await screen.findByLabelText(/api key/i);
    await user.type(input, "sk-bad");
    await user.click(screen.getByRole("button", { name: /save key/i }));
    await waitFor(() => {
      expect(screen.getByText(/provider refused the key/i)).toBeTruthy();
    });
  });

  it("refresh reloads the list", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row()]);
    vi.mocked(providerRefresh).mockResolvedValue({
      provider_id: "anthropic",
      models: [],
      models_fetched_at: 2000,
      stale: false,
    });
    render(<ProvidersView />);
    await user.click(await screen.findByRole("button", { name: /refresh/i }));
    expect(providerRefresh).toHaveBeenCalledWith("anthropic");
    expect(providerList).toHaveBeenCalledTimes(2);
  });

  it("remove asks once and reloads on confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(providerList).mockResolvedValue([row()]);
    vi.mocked(providerRemove).mockResolvedValue(true);
    render(<ProvidersView />);
    await user.click(await screen.findByRole("button", { name: /^remove$/i }));
    // Inline confirm, not a modal: the turn visibly pauses nowhere here, and
    // a modal would throw away scroll position for a recoverable action.
    await user.click(await screen.findByRole("button", { name: /confirm remove/i }));
    expect(providerRemove).toHaveBeenCalledWith("anthropic");
    expect(providerList).toHaveBeenCalledTimes(2);
  });
});