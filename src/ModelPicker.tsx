/**
 * Model picker (Task 003). Lists every catalogue model with its limits.
 * Selecting one writes thread-level state only — the thread stays open.
 * Unknown selections degrade to a typed notice, never a crash.
 */
import { Bot, Database, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { CatalogueModel, CataloguePayload } from "./catalogue";
import { resolveLimits, switchWarnings, type ModelRef } from "./models";
import { useThreadStore } from "./thread";

function formatTokens(n: number): string {
  const k = Math.round(n / 1000).toString();
  return n >= 1000 ? `${k}k` : n.toString();
}

export default function ModelPicker({
  payload,
  threadId,
}: {
  payload: CataloguePayload;
  threadId: string;
}) {
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

  const entries: { provider: string; model: CatalogueModel }[] = [];
  for (const [provider, models] of Object.entries(payload.catalogue.providers)) {
    for (const model of models) entries.push({ provider, model });
  }

  function choose(provider: string, model: CatalogueModel) {
    const ref: ModelRef = { provider, id: model.id };
    const resolved = resolveLimits(ref, {
      serverSnapshot: {
        contextWindow: model.context_window,
        maxOutput: model.max_output,
        reasoning: model.reasoning,
        toolCall: model.tool_call,
      },
    });
    if ("unknown" in resolved) {
      setNotice(`Unknown model ${ref.provider}/${ref.id} — picker still usable.`);
      return;
    }
    const next = { ...ref, name: model.name, ...resolved.limits };
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
      <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
        {entries.map(({ provider, model }) => {
          const active =
            current !== null && current.provider === provider && current.id === model.id;
          return (
            <li key={`${provider}/${model.id}`}>
              <button
                type="button"
                onClick={() => {
                  choose(provider, model);
                }}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-neutral-900 ${
                  active ? "bg-neutral-900 text-neutral-100" : "text-neutral-300"
                }`}
              >
                <Bot size={16} className="shrink-0 text-neutral-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{model.name}</span>
                  <span className="block text-xs text-neutral-500">
                    {provider}/{model.id}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatTokens(model.context_window)} ctx · {formatTokens(model.max_output)} out
                  {model.reasoning ? " · thinking" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {entries.length === 0 && (
        <p className="text-sm text-neutral-500">Catalogue empty — nothing to pick.</p>
      )}
    </div>
  );
}
