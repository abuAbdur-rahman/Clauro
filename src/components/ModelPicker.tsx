/**
 * Model picker on shadcn Select (Task 025, D112). Lists every catalogue model
 * grouped by provider with its limits. Selecting one writes thread-level state
 * only — the thread stays open. Unknown selections degrade to a typed notice,
 * never a crash.
 */
import { Database, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { CatalogueModel, CataloguePayload } from "../features/catalogue/catalogue";
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

function optionText(model: CatalogueModel): string {
  return `${formatTokens(model.context_window)} ctx · ${formatTokens(model.max_output)} out${model.reasoning ? " · thinking" : ""}`;
}

export default function ModelPicker({
  payload,
  threadId,
}: {
  payload: CataloguePayload;
  threadId: string;
}): React.JSX.Element {
  const [notice, setNotice] = useState<string | null>(null);
  const selectModel = useThreadStore((s) => s.selectModel);
  const current = useThreadStore((s) => s.threads[threadId]?.model ?? null);

  if (payload.state === "absent") {
    return (
      <div className="rounded border border-neutral-800 p-4 text-sm text-neutral-400">
        <p className="flex items-center gap-2">
          <TriangleAlert size={16} /> No cached catalogue and offline.
        </p>
        <p className="mt-1 text-neutral-500">Connect once to fetch the model list.</p>
      </div>
    );
  }
  if (payload.state === "stale") {
    return <p className="text-sm text-neutral-500">Catalogue stale. Refreshing…</p>;
  }

  const entries: { provider: string; model: CatalogueModel; value: string }[] = [];
  for (const [provider, models] of Object.entries(payload.catalogue.providers)) {
    for (const model of models) entries.push({ provider, model, value: `${provider}/${model.id}` });
  }
  const providers = Object.keys(payload.catalogue.providers);
  const currentValue =
    current === null ? undefined : `${current.provider}/${current.id}`;

  function choose(value: string) {
    const entry = entries.find((e) => e.value === value);
    if (entry === undefined) {
      setNotice(`Unknown model ${value} — picker still usable.`);
      return;
    }
    const ref: ModelRef = { provider: entry.provider, id: entry.model.id };
    const resolved = resolveLimits(ref, {
      serverSnapshot: {
        contextWindow: entry.model.context_window,
        maxOutput: entry.model.max_output,
        reasoning: entry.model.reasoning,
        toolCall: entry.model.tool_call,
      },
    });
    if ("unknown" in resolved) {
      setNotice(`Unknown model ${ref.provider}/${ref.id} — picker still usable.`);
      return;
    }
    const next = { ...ref, name: entry.model.name, ...resolved.limits };
    if (current) {
      const warns = switchWarnings(current, next);
      setNotice(warns.length > 0 ? warns[0] : null);
    } else {
      setNotice(null);
    }
    selectModel(threadId, next);
  }

  return (
    <div>
      {payload.state === "cached" && (
        <p className="mb-2 flex items-center gap-2 text-xs text-amber-400/90">
          <Database size={14} /> Cached catalogue{payload.notice ? ` — ${payload.notice}` : ""}.{" "}
          {payload.models} models.
        </p>
      )}
      {notice && (
        <p className="mb-2 flex items-center gap-2 text-xs text-amber-300">
          <TriangleAlert size={14} /> {notice}
        </p>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-neutral-500">Catalogue empty — nothing to pick.</p>
      ) : (
        <Select value={currentValue} onValueChange={choose}>
          <SelectTrigger aria-label="Model" className="w-full max-w-2xl">
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((provider) => (
              <SelectGroup key={provider}>
                <SelectLabel>{provider}</SelectLabel>
                {entries
                  .filter((e) => e.provider === provider)
                  .map(({ model, value }) => (
                    <SelectItem key={value} value={value}>
                      {model.name} · {optionText(model)}
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
