/**
 * ProvidersView: the settings surface for endpoints, keys, and model lists.
 *
 * One configured provider per card: name, kind, model count with freshness,
 * key status, and the actions that change them. Adding is two shapes — a
 * built-in button, or the custom form (id + display name + endpoint URL).
 * Keys are password inputs that are cleared after saving; the key itself is
 * never rendered back.
 *
 * Removal confirms inline, not as a modal (DESIGN.md §2.3's reasoning holds
 * here too: a modal breaks position for a recoverable action — re-adding a
 * provider is one click plus a pasted key).
 */
import { useCallback, useEffect, useState } from "react";
import {
  providerAddBuiltin,
  providerAddCustom,
  providerList,
  providerRefresh,
  providerRemove,
  providerSetKey,
  type ProviderView as ProviderRow,
} from "./providers";

const BUILTINS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
];

export function ProvidersView(): React.JSX.Element {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await providerList());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function add(id: string): Promise<void> {
    setNotice(null);
    try {
      await providerAddBuiltin(id);
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  if (rows === null) {
    return <p className="text-sm text-neutral-500">Loading providers…</p>;
  }

  return (
    <div data-testid="providers-view">
      <h1 className="text-base text-neutral-100">Providers</h1>
      <p className="mt-1 text-xs text-neutral-500">
        One endpoint, one key, one model list. The picker shows only what is configured here.
      </p>
      {notice && (
        <p role="status" className="mt-2 text-xs text-amber-400">
          {notice}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400">
          No providers configured. Add one below — the model picker stays empty until then.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((row) => (
            <ProviderCard
              key={row.id}
              row={row}
              confirming={confirming === row.id}
              onConfirmStart={() => {
                setConfirming(row.id);
              }}
              onConfirmCancel={() => {
                setConfirming(null);
              }}
              onChanged={reload}
              onNotice={setNotice}
            />
          ))}
        </ul>
      )}
      <div className="mt-6">
        <h2 className="text-sm text-neutral-200">Add a provider</h2>
        <div className="mt-2 flex gap-2">
          {BUILTINS.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                void add(b.id);
              }}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Add {b.label}
            </button>
          ))}
        </div>
        <CustomForm onAdded={reload} onNotice={setNotice} />
      </div>
    </div>
  );
}

function ProviderCard({
  row,
  confirming,
  onConfirmStart,
  onConfirmCancel,
  onChanged,
  onNotice,
}: {
  row: ProviderRow;
  confirming: boolean;
  onConfirmStart: () => void;
  onConfirmCancel: () => void;
  onChanged: () => Promise<void>;
  onNotice: (notice: string | null) => void;
}): React.JSX.Element {
  const [key, setKey] = useState("");

  async function saveKey(): Promise<void> {
    onNotice(null);
    try {
      await providerSetKey(row.id, key);
      setKey("");
      await onChanged();
    } catch (e) {
      // A rejected key stores nothing (the host rolls back): the card stays
      // keyless and the notice says why.
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function refresh(): Promise<void> {
    onNotice(null);
    try {
      await providerRefresh(row.id);
      await onChanged();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(): Promise<void> {
    onNotice(null);
    try {
      await providerRemove(row.id);
      onConfirmCancel();
      await onChanged();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <li className="rounded border border-neutral-800 p-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-neutral-100">{row.display_name}</p>
        <span className="text-xs text-neutral-500">{row.kind}</span>
        <span className="flex-1" />
        {row.has_key ? (
          <span className="text-xs text-neutral-400">key saved</span>
        ) : (
          <span className="text-xs text-amber-400">key missing</span>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {row.model_count} models
        {row.models_fetched_at === null
          ? " · never fetched"
          : row.stale
            ? " · list is stale"
            : " · list is fresh"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`key-${row.id}`}>
          API key for {row.display_name}
        </label>
        <input
          id={`key-${row.id}`}
          type="password"
          value={key}
          placeholder={row.has_key ? "Replace key…" : "Paste API key…"}
          onChange={(e) => {
            setKey(e.target.value);
          }}
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        />
        <button
          type="button"
          disabled={key.trim() === ""}
          onClick={() => {
            void saveKey();
          }}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          Save key
        </button>
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Refresh
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => {
                void remove();
              }}
              className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
            >
              Confirm remove
            </button>
            <button
              type="button"
              onClick={onConfirmCancel}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onConfirmStart}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function CustomForm({
  onAdded,
  onNotice,
}: {
  onAdded: () => Promise<void>;
  onNotice: (notice: string | null) => void;
}): React.JSX.Element {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  async function submit(): Promise<void> {
    onNotice(null);
    try {
      await providerAddCustom({ id, displayName: name, baseUrl: url });
      setId("");
      setName("");
      setUrl("");
      await onAdded();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mt-3 rounded border border-neutral-800 p-3">
      <p className="text-xs text-neutral-400">
        Custom OpenAI-compatible endpoint — covers gateways, local servers, and vendors without a
        button above.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <label className="text-xs text-neutral-400">
          Provider id (lowercase, dashes)
          <input
            aria-label="Provider id"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
            }}
            placeholder="office-gateway"
            className="mt-1 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          />
        </label>
        <label className="text-xs text-neutral-400">
          Display name
          <input
            aria-label="Display name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="Office gateway"
            className="mt-1 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          />
        </label>
        <label className="text-xs text-neutral-400">
          Endpoint URL
          <input
            aria-label="Endpoint URL"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
            placeholder="https://llm.office.example/v1"
            className="mt-1 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            void submit();
          }}
          className="self-start rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Add endpoint
        </button>
      </div>
    </div>
  );
}
