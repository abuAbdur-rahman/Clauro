/**
 * Model picker on shadcn Select (Task 025, D112). Lists only configured
 * providers' stored models, grouped by provider, with limits where the
 * enrichment knows them. Selecting one writes thread-level state only — the
 * thread stays open. A model with unknown limits cannot be selected: the
 * picker says so instead of zero-guessing (CONTRACTS.md §5).
 */
import { Database, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { EnrichedModel } from "../features/providers/providers";
import { providerList, providerModelsEnriched } from "../features/providers/providers";
import { resolveLimits, switchWarnings, type ModelRef } from "../features/catalogue/models";
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

interface Entry {
  provider: string;
  providerName: string;
  model: EnrichedModel;
  value: string;
}

export default function ModelPicker({
  threadId,
  compact = false,
}: {
  threadId: string;
  /** Compact trigger for the composer footer; default is the full-width picker. */
  compact?: boolean;
}): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectModel = useThreadStore((s) => s.selectModel);
  const current = useThreadStore((s) => s.threads[threadId]?.model ?? null);

  useEffect(() => {
    // Read through a call (see App.tsx): property narrowing would otherwise
    // conclude the flag never changes and flag every check as unnecessary.
    const cancelled = { value: false };
    const isCancelled = () => cancelled.value;
    void (async () => {
      try {
        const providers = await providerList();
        const all: Entry[] = [];
        for (const p of providers) {
          const models = await providerModelsEnriched(p.id);
          for (const model of models) {
            all.push({
              provider: p.id,
              providerName: p.display_name,
              model,
              value: `${p.id}/${model.id}`,
            });
          }
        }
        if (!isCancelled()) setEntries(all);
      } catch (e) {
        if (!isCancelled()) setNotice(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled.value = true;
    };
  }, []);

  if (entries === null) {
    return (
      <p className="text-sm text-neutral-500">
        {notice ?? "Loading models…"}
      </p>
    );
  }

  const currentValue = current === null ? undefined : `${current.provider}/${current.id}`;

  function choose(value: string) {
    const entry = entries?.find((e) => e.value === value);
    if (entry === undefined) {
      setNotice(`Unknown model ${value} — picker still usable.`);
      return;
    }
    if (!entry.model.limits_known) {
      // Custom-endpoint models the enrichment never heard of: selectable once
      // live turns carry per-model limits, not before. The notice names the
      // reason instead of guessing.
      setNotice(
        `No limits known for ${value} — selection unlocks with live turns for custom endpoints.`,
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

  const groups = [...new Set(entries.map((e) => e.provider))];

  return (
    <div>
      {notice && (
        <p className="mb-2 flex items-center gap-2 text-xs text-amber-300">
          <TriangleAlert size={14} /> {notice}
        </p>
      )}
      {entries.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-neutral-400">
          <Database size={14} /> No providers configured — the picker stays empty until then.
        </p>
      ) : (
        <Select value={currentValue} onValueChange={choose}>
          <SelectTrigger
            aria-label="Model"
            size="sm"
            className={compact ? "w-auto max-w-48" : "w-full max-w-2xl"}
          >
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            {groups.map((provider) => (
              <SelectGroup key={provider}>
                <SelectLabel>
                  {entries.find((e) => e.provider === provider)?.providerName ?? provider}
                </SelectLabel>
                {entries
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
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
