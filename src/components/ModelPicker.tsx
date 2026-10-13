/**
 * Model picker on shadcn Select (Task 025, D112). Lists only configured
 * providers' stored models, grouped by provider, with limits where the
 * enrichment knows them. Selecting one writes thread-level state only — the
 * thread stays open. A model with unknown limits cannot be selected: the
 * picker says so instead of zero-guessing (CONTRACTS.md §5).
 */
import { Database, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { loadModelEntries, type ModelEntry } from "../features/providers/modelEntries";
import { resolveLimits, switchWarnings, type ModelRef } from "../features/catalogue/models";
import { useSettingsStore } from "../features/shell/settings";
import { useThreadStore } from "../features/catalogue/thread";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

function formatTokens(n: number): string {
  const k = Math.round(n / 1000).toString();
  return n >= 1000 ? `${k}k` : n.toString();
}

/** Terminal picker value. Never a model id (no provider uses it); the
 *  lookup would fail it as unknown, so interception must come first. */
const ADD_PROVIDER_VALUE = "__add_provider__";

/**
 * `clauro.models.hidden` (Settings → Models): a `${provider}:${model}` → true
 * map of models the user hid. Parsed leniently because a preference is
 * advisory — corrupt JSON hides nothing rather than breaking the picker.
 */
function readHiddenModels(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem("clauro.models.hidden");
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // private-mode storage or unreadable JSON: honour nothing, break nothing
  }
  return {};
}

/** `clauro.prefs.defaultModel` is `providerId:modelId` (see applyStoredDefault). */
function readDefaultModel(): string {
  try {
    return window.localStorage.getItem("clauro.prefs.defaultModel") ?? "";
  } catch {
    return "";
  }
}

export default function ModelPicker({
  threadId,
  compact = false,
}: {
  threadId: string;
  /** Compact trigger for the composer footer; default is the full-width picker. */
  compact?: boolean;
}): React.JSX.Element {
  const [entries, setEntries] = useState<ModelEntry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Controlled open: the filter's Enter path selects programmatically, and a
  // programmatic value change leaves an uncontrolled Select open.
  const [open, setOpen] = useState(false);
  // Filter stays on the Select (not a popover+command rebuild): no command
  // primitive exists in ui/ and the Select role contract pins grouping/tests.
  const [filter, setFilter] = useState("");
  const selectModel = useThreadStore((s) => s.selectModel);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const current = useThreadStore((s) => s.threads[threadId]?.model ?? null);

  useEffect(() => {
    // Read through a call (see App.tsx): property narrowing would otherwise
    // conclude the flag never changes and flag every check as unnecessary.
    const cancelled = { value: false };
    const isCancelled = () => cancelled.value;
    loadModelEntries().then(
      (loaded) => {
        if (isCancelled()) return;
        setEntries(loaded);
        applyStoredDefault(loaded);
      },
      (e: unknown) => {
        // One plain sentence, never a Zod dump: the harness caught a raw
        // validation JSON rendering here 2026-10-07 (a float timestamp the
        // real backend never sends, but the rule holds for every failure).
        if (!isCancelled()) {
          const msg = e instanceof Error ? e.message : String(e);
          setNotice(msg.length > 160 ? `${msg.slice(0, 160)}…` : msg);
        }
      },
    );
    return () => {
      cancelled.value = true;
    };
  }, []);

  if (entries === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {notice ?? "Loading models…"}
      </p>
    );
  }

  const currentValue = current === null ? undefined : `${current.provider}/${current.id}`;

  /** Terminal entry id. Intercepted before lookup: it opens Settings, never
   *  a model (DESIGN §2.5 requires it; the picker must not dead-end). */
  function choose(value: string) {
    if (value === ADD_PROVIDER_VALUE) {
      openSettings("providers");
      return;
    }
    const entry = entries?.find((e) => e.value === value);
    if (entry === undefined) {
      setNotice(`Unknown model ${value} — picker still usable.`);
      return;
    }
    selectEntry(entry);
  }

  /**
   * Commit a known entry. Split from `choose` so the stored-default path can
   * pass the freshly loaded entry itself: `choose` resolves through the
   * `entries` state, which the load effect's own closure still sees as null.
   */
  function selectEntry(entry: ModelEntry): void {
    if (!entry.model.limits_known) {
      // Custom-endpoint models the enrichment never heard of: selectable once
      // live turns carry per-model limits, not before. The notice names the
      // reason instead of guessing.
      setNotice(
        `No limits known for ${entry.value} — selection unlocks with live turns for custom endpoints.`,
      );
      return;
    }
    const ref: ModelRef = { provider: entry.provider, id: entry.model.id };
    const resolved = resolveLimits(ref, {
      serverSnapshot: {
        contextWindow: entry.model.context_window ?? undefined,
        maxOutput: entry.model.max_output ?? undefined,
        reasoning: entry.model.reasoning,
        toolCall: entry.model.tool_call,
      },
    });
    if ("unknown" in resolved) {
      setNotice(`Unknown model ${ref.provider}/${ref.id} — picker still usable.`);
      return;
    }
    const next = { ...ref, name: entry.model.display_name, ...resolved.limits };
    if (current) {
      const warns = switchWarnings(current, next);
      setNotice(warns.length > 0 ? warns[0] : null);
    } else {
      setNotice(null);
    }
    selectModel(threadId, next);
  }

  /**
   * `clauro.prefs.defaultModel` ("Used for new chats", Settings → Models):
   * a thread with no model picks up the stored `provider:modelId` once the
   * list is known. An unmatched key (renamed model, removed provider), an
   * unknown-limits default, and a thread that already chose all stay
   * untouched — a preference is never an error, and an unhonourable one must
   * not shout on first paint.
   */
  function applyStoredDefault(loaded: ModelEntry[]): void {
    const pref = readDefaultModel();
    if (pref === "") return;
    const state = useThreadStore.getState().threads[threadId];
    if (state === undefined || (state.model ?? null) !== null) return;
    const entry = loaded.find((e) => `${e.provider}:${e.model.id}` === pref);
    if (entry !== undefined) selectEntry(entry);
  }

  const hidden = readHiddenModels();
  const listed = entries.filter(
    (e) => hidden[`${e.provider}:${e.model.id}`] !== true,
  );
  const query = filter.trim().toLowerCase();
  const visible =
    query === ""
      ? listed
      : listed.filter(
          (e) =>
            e.model.display_name.toLowerCase().includes(query) ||
            e.model.id.toLowerCase().includes(query) ||
            e.providerName.toLowerCase().includes(query),
        );
  const visibleGroups = [...new Set(visible.map((e) => e.provider))];

  return (
    <div>
      {notice && (
        <p className="mb-2 flex items-center gap-2 text-xs text-destructive">
          <TriangleAlert size={14} /> {notice}
        </p>
      )}
      {listed.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Database size={14} />
          {entries.length === 0
            ? "No providers configured — the picker stays empty until then."
            : "All models are hidden — show one in Settings → Models."}
        </p>
      ) : (
        <Select
          open={open}
          onOpenChange={setOpen}
          /* Spread, not `value={currentValue}`: Radix's optional `value` plus
             exactOptionalPropertyTypes rejects an explicit `undefined`.
             Omitting it is what `undefined` meant anyway (uncontrolled until
             a model is chosen). */
          {...(currentValue === undefined ? {} : { value: currentValue })}
          onValueChange={choose}
        >
          <SelectTrigger
            aria-label="Model"
            size="sm"
            className={compact ? "w-auto max-w-48" : "w-full max-w-2xl"}
          >
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            <div className="p-2">
              <input
                aria-label="Search models"
                placeholder="Search models"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                }}
                onKeyDown={(e) => {
                  // Printables stay in the box: Radix's typeahead would move
                  // the highlight mid-word while the user is typing a filter.
                  // Everything else propagates — Arrow/Enter/Escape must reach
                  // the Select (the review-32/61 keyboard trap was a blanket
                  // stopPropagation that swallowed them all).
                  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.stopPropagation();
                    return;
                  }
                  // Enter with an active filter picks the top match: nothing is
                  // highlighted yet, so bubbling would do nothing at all.
                  // Controlled `open` is what lets this close the popup — a
                  // programmatic value change does not close it by itself.
                  if (e.key === "Enter" && query !== "" && visible.length > 0) {
                    const first = visible[0];
                    if (first.model.limits_known) {
                      e.preventDefault();
                      e.stopPropagation();
                      choose(first.value);
                      setOpen(false);
                    }
                  }
                }}
                className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            {visible.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
            ) : (
              visibleGroups.map((provider) => (
                <SelectGroup key={provider}>
                  <SelectLabel>
                    {entries.find((e) => e.provider === provider)?.providerName ?? provider}
                  </SelectLabel>
                  {visible
                    .filter((e) => e.provider === provider)
                    .map(({ model, value }) => (
                      <SelectItem key={value} value={value} disabled={!model.limits_known}>
                        {model.display_name} ·{" "}
                        {model.limits_known && model.context_window && model.max_output
                          ? `${formatTokens(model.context_window)} ctx · ${formatTokens(model.max_output)} out${model.reasoning ? " · thinking" : ""}`
                          : "limits unknown"}
                      </SelectItem>
                    ))}
                </SelectGroup>
              ))
            )}
            <SelectItem value={ADD_PROVIDER_VALUE}>Add provider…</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
