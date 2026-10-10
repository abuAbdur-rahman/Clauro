/**
 * ProvidersView: the settings surface for endpoints, keys, and model lists.
 *
 * One configured provider per card: logo-initials, name, endpoint URL,
 * masked key, status pill, enable switch, and Edit/Test/Delete. Adding and
 * editing happen in a Radix dialog: type select (autofills name and URL but
 * never wipes a custom value once typed), name, base URL, Replace-key input
 * with an eye toggle, model chips with add/remove, Fetch (stored models),
 * Test (live proof), and a Save gated on the zod form contract.
 *
 * Key rules that never weaken: the stored key is never echoed — the card
 * shows only a static mask from `has_key`, the dialog collects a
 * replacement into a blank field. Saving a key proves it with
 * `providerSet_key`'s live fetch; on refusal the host rolls the key back,
 * the notice says why, and the dialog stays open so the key can be fixed.
 * Removal confirms in a dismissable dialog (Cancel, Delete, Esc,
 * outside-click) — never `window.confirm`. The host has no rename or
 * enable endpoint, so name/URL edits and the enable switch are stated
 * honestly: the switch is a local, persisted preference, and saving an
 * edit without a replacement key says re-adding is required.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import {
  isProviderFormValid,
  PROVIDER_PRESETS,
  providerAddBuiltin,
  providerAddCustom,
  providerList,
  providerModels,
  providerRefresh,
  providerRemove,
  providerSetKey,
  slugifyProviderId,
  type ProviderType,
  type ProviderView as ProviderRow,
} from "./providers";

type ProbeStatus = "untested" | "testing" | "connected" | "error";

const STATUS_LABEL: Record<ProbeStatus, string> = {
  untested: "Untested",
  testing: "Testing…",
  connected: "Connected",
  error: "Error",
};

const STATUS_CLASS: Record<ProbeStatus, string> = {
  untested: "text-neutral-400",
  testing: "text-amber-400",
  connected: "text-green-400",
  error: "text-red-400",
};

const TYPE_ORDER = Object.keys(PROVIDER_PRESETS) as ProviderType[];

const ENABLED_STORAGE_KEY = "clauro.providers.enabled";
const MASKED_KEY = "••••••••";

function loadEnabled(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(ENABLED_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const second = parts[1] ?? "";
  return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
}

/** Best guess at the dialog type for a stored row (kind + endpoint root). */
function typeForRow(row: ProviderRow): ProviderType {
  if (row.kind === "anthropic") return "anthropic";
  const url = row.base_url ?? "";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("11434") || url.includes("localhost")) return "ollama";
  if (row.kind === "openai-compatible" && url === "") return "openai";
  return "custom";
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ProvidersView(): React.JSX.Element {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<Record<string, ProbeStatus>>({});
  const [enabled, setEnabled] = useState<Record<string, boolean>>(loadEnabled);
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; row: ProviderRow } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<ProviderRow | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await providerList());
    } catch (e) {
      setNotice(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setStatus = useCallback((id: string, status: ProbeStatus) => {
    setStatusById((prev) => ({ ...prev, [id]: status }));
  }, []);

  function toggleEnabled(id: string): void {
    setEnabled((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? true) };
      try {
        window.localStorage.setItem(ENABLED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // A full or blocked store must not break the toggle itself.
      }
      return next;
    });
  }

  async function testProvider(id: string): Promise<void> {
    setStatus(id, "testing");
    setNotice(null);
    const started = Date.now();
    try {
      const view = await providerRefresh(id);
      setStatus(id, "connected");
      setNotice(`Connected · ${String(view.models.length)} models · ${String(Date.now() - started)}ms`);
      await reload();
    } catch (e) {
      setStatus(id, "error");
      setNotice(errorText(e));
    }
  }

  async function confirmRemove(): Promise<void> {
    if (deleting === null) return;
    const id = deleting.id;
    setNotice(null);
    try {
      await providerRemove(id);
      setDeleting(null);
      await reload();
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  if (rows === null) {
    return <p className="text-sm text-neutral-500">Loading providers…</p>;
  }

  return (
    <div data-testid="providers-view">
      <div className="flex items-center gap-2">
        <div>
          <h1 className="text-base text-neutral-100">Providers</h1>
          <p className="mt-1 text-xs text-neutral-500">
            One endpoint, one key, one model list. The picker shows only what is configured here.
          </p>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="provider-add"
          onClick={() => {
            setDialog({ mode: "add" });
          }}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Add provider
        </button>
      </div>
      {notice && (
        <p role="status" className="mt-2 text-xs text-amber-400">
          {notice}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400">
          No providers configured. Add one above — the model picker stays empty until then.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((row) => (
            <ProviderCard
              key={row.id}
              row={row}
              status={statusById[row.id] ?? "untested"}
              enabled={enabled[row.id] ?? true}
              onToggleEnabled={() => {
                toggleEnabled(row.id);
              }}
              onTest={() => {
                void testProvider(row.id);
              }}
              onEdit={() => {
                setDialog({ mode: "edit", row });
              }}
              onDelete={() => {
                setDeleting(row);
              }}
            />
          ))}
        </ul>
      )}
      {dialog !== null && (
        <ProviderDialog
          mode={dialog.mode}
          row={dialog.mode === "edit" ? dialog.row : null}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={reload}
          onNotice={setNotice}
          onStatus={setStatus}
        />
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent data-testid="provider-delete-confirm">
          <DialogTitle>Delete {deleting?.display_name ?? "provider"}?</DialogTitle>
          <p className="text-xs text-neutral-400">
            {deleting?.display_name ?? "This provider"} and its models will be removed, and its
            stored key deleted. Re-adding takes one click plus a pasted key.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="provider-delete-confirm-cancel"
              onClick={() => {
                setDeleting(null);
              }}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="provider-delete-confirm-ok"
              onClick={() => {
                void confirmRemove();
              }}
              className="rounded border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950"
            >
              Delete
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusPill({
  status,
  testId,
}: {
  status: ProbeStatus;
  testId: string;
}): React.JSX.Element {
  return (
    <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function EnableSwitch({
  id,
  enabled,
  label,
  onToggle,
}: {
  id: string;
  enabled: boolean;
  label: string;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      data-testid={`provider-enable-${id}`}
      onClick={onToggle}
      className={`flex h-5 w-10 items-center rounded-full border px-0.5 ${
        enabled ? "justify-end border-green-700 bg-green-950" : "justify-start border-neutral-700"
      }`}
    >
      <span className={`h-3.5 w-3.5 rounded-full ${enabled ? "bg-green-400" : "bg-neutral-500"}`} />
    </button>
  );
}

function ProviderCard({
  row,
  status,
  enabled,
  onToggleEnabled,
  onTest,
  onEdit,
  onDelete,
}: {
  row: ProviderRow;
  status: ProbeStatus;
  enabled: boolean;
  onToggleEnabled: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const testing = status === "testing";
  return (
    <li data-testid={`provider-card-${row.id}`} className="rounded border border-neutral-800 p-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 flex-none place-items-center rounded-full bg-neutral-700 text-xs font-semibold text-neutral-100"
        >
          {initialsOf(row.display_name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-100">{row.display_name}</p>
          <p
            data-testid={`provider-url-${row.id}`}
            className="truncate text-xs text-neutral-500"
          >
            {row.base_url ?? row.kind}
          </p>
          <p
            data-testid={`provider-key-${row.id}`}
            className="font-mono text-xs text-neutral-500"
          >
            {row.has_key ? MASKED_KEY : "No key"}
          </p>
        </div>
        <StatusPill status={status} testId={`provider-status-${row.id}`} />
        <EnableSwitch
          id={row.id}
          enabled={enabled}
          label={`Enable ${row.display_name}`}
          onToggle={onToggleEnabled}
        />
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
        <button
          type="button"
          data-testid={`provider-edit-${row.id}`}
          onClick={onEdit}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Edit
        </button>
        <button
          type="button"
          data-testid={`provider-test-${row.id}`}
          disabled={testing}
          onClick={onTest}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          data-testid={`provider-delete-${row.id}`}
          onClick={onDelete}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function ProviderDialog({
  mode,
  row,
  onClose,
  onSaved,
  onNotice,
  onStatus,
}: {
  mode: "add" | "edit";
  row: ProviderRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onNotice: (notice: string | null) => void;
  onStatus: (id: string, status: ProbeStatus) => void;
}): React.JSX.Element {
  const initialType: ProviderType = row === null ? "openai" : typeForRow(row);
  const initialPreset = PROVIDER_PRESETS[initialType];
  const [type, setType] = useState<ProviderType>(initialType);
  const [name, setName] = useState<string>(row?.display_name ?? initialPreset.name);
  const [baseUrl, setBaseUrl] = useState<string>(row?.base_url ?? initialPreset.baseUrl);
  // Edit mode loads host-owned values, so a type switch must not overwrite
  // them; add mode starts from the preset, pristine until typed.
  const [touchedName, setTouchedName] = useState<boolean>(row !== null);
  const [touchedUrl, setTouchedUrl] = useState<boolean>(row !== null);
  // The stored key is never echoed: this field starts blank and only ever
  // carries a replacement to prove.
  const [key, setKey] = useState<string>("");
  const [showKey, setShowKey] = useState<boolean>(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState<string>("");
  const [status, setDialogStatus] = useState<ProbeStatus>("untested");
  const [busy, setBusy] = useState<"fetch" | "test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function changeType(next: ProviderType): void {
    setType(next);
    setDialogStatus("untested");
    const preset = PROVIDER_PRESETS[next];
    if (!touchedName) setName(preset.name);
    if (!touchedUrl) setBaseUrl(preset.baseUrl);
  }

  const valid =
    busy === null &&
    isProviderFormValid(
      { type, name, baseUrl, key },
      mode === "edit" ? { allowBlankKey: true } : undefined,
    );

  async function fetchModels(): Promise<void> {
    if (row === null) return;
    setBusy("fetch");
    setError(null);
    try {
      const view = await providerModels(row.id);
      setModels(view.models.map((m) => m.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(): Promise<void> {
    if (row === null) return;
    setBusy("test");
    setDialogStatus("testing");
    setError(null);
    const started = Date.now();
    try {
      const view = await providerRefresh(row.id);
      setDialogStatus("connected");
      onStatus(row.id, "connected");
      onNotice(
        `Connected · ${String(view.models.length)} models · ${String(Date.now() - started)}ms`,
      );
      setModels(view.models.map((m) => m.id));
      await onSaved();
    } catch (e) {
      setDialogStatus("error");
      onStatus(row.id, "error");
      setError(errorText(e));
      onNotice(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  function addChip(): void {
    const id = modelInput.trim();
    if (id === "" || models.includes(id)) return;
    setModels((prev) => [...prev, id]);
    setModelInput("");
  }

  async function save(): Promise<void> {
    setBusy("save");
    setError(null);
    onNotice(null);
    try {
      if (mode === "add") {
        let id: string;
        if (type === "openai" || type === "anthropic" || type === "openrouter") {
          id = (await providerAddBuiltin(type)).id;
        } else {
          id = (
            await providerAddCustom({
              id: slugifyProviderId(name),
              displayName: name.trim(),
              baseUrl: baseUrl.trim(),
            })
          ).id;
        }
        if (key.trim() !== "") {
          try {
            const proven = await providerSetKey(id, key);
            onStatus(id, "connected");
            onNotice(`Connected · ${String(proven.models.length)} models`);
          } catch (e) {
            // The host rolled the bad key back: the row stays keyless and
            // the dialog stays open so the key can be fixed.
            onStatus(id, "error");
            setError(errorText(e));
            onNotice(errorText(e));
            await onSaved();
            return;
          }
        }
        await onSaved();
        onClose();
        return;
      }
      if (row === null) return;
      if (key.trim() === "") {
        setError(
          "No key entered. The host has no rename endpoint yet — re-add the provider to change its name or URL.",
        );
        return;
      }
      try {
        const proven = await providerSetKey(row.id, key);
        setDialogStatus("connected");
        onStatus(row.id, "connected");
        onNotice(`Connected · ${String(proven.models.length)} models`);
        await onSaved();
        onClose();
      } catch (e) {
        // Same rollback rule as the old inline form: a rejected key stores
        // nothing, the card stays keyless, and the notice says why.
        setDialogStatus("error");
        onStatus(row.id, "error");
        setError(errorText(e));
        onNotice(errorText(e));
        await onSaved();
      }
    } catch (e) {
      setError(errorText(e));
      onNotice(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="provider-dialog" aria-label={`${mode === "add" ? "Add" : "Edit"} provider`}>
        <DialogTitle>{mode === "add" ? "Add provider" : `Edit ${row?.display_name ?? "provider"}`}</DialogTitle>
        <div className="flex flex-col gap-3">
          <label className="text-xs text-neutral-400">
            Type
            <select
              data-testid="provider-dialog-type"
              aria-label="Provider type"
              value={type}
              onChange={(e) => {
                changeType(e.target.value as ProviderType);
              }}
              className="mt-1 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            >
              {TYPE_ORDER.map((t) => (
                <option key={t} value={t}>
                  {PROVIDER_PRESETS[t].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-neutral-400">
            Name
            <input
              data-testid="provider-dialog-name"
              aria-label="Provider name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setTouchedName(true);
              }}
              placeholder="Office gateway"
              className="mt-1 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            />
          </label>
          <label className="text-xs text-neutral-400">
            Base URL
            <input
              data-testid="provider-dialog-url"
              aria-label="Base URL"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setTouchedUrl(true);
              }}
              placeholder={type === "anthropic" ? "Built-in endpoint" : "https://"}
              className="mt-1 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            />
          </label>
          <div className="text-xs text-neutral-400">
            <label htmlFor="provider-dialog-key">
              {mode === "edit" ? "Replace key (blank keeps the stored one)" : "API key"}
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="provider-dialog-key"
                data-testid="provider-dialog-key"
                type={showKey ? "text" : "password"}
                value={key}
                placeholder={type === "ollama" ? "Optional for local servers" : mode === "edit" ? "Replace key…" : "sk-…"}
                onChange={(e) => {
                  setKey(e.target.value);
                  setDialogStatus("untested");
                }}
                className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
              />
              <button
                type="button"
                data-testid="provider-dialog-eye"
                aria-label="Show or hide key"
                aria-pressed={showKey}
                onClick={() => {
                  setShowKey((prev) => !prev);
                }}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-neutral-400">Models</p>
              <span className="flex-1" />
              <StatusPill status={status} testId="provider-dialog-status" />
            </div>
            <div data-testid="provider-dialog-chips" className="mt-1 flex min-h-6 flex-wrap gap-1">
              {models.length === 0 ? (
                <span className="text-xs text-neutral-500">No models yet — Fetch to load.</span>
              ) : (
                models.map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200"
                  >
                    {m}
                    <button
                      type="button"
                      aria-label={`Remove ${m}`}
                      onClick={() => {
                        setModels((prev) => prev.filter((x) => x !== m));
                      }}
                      className="text-neutral-400 hover:text-neutral-100"
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                data-testid="provider-dialog-model-input"
                aria-label="Add model ID"
                value={modelInput}
                placeholder="Add model ID"
                onChange={(e) => {
                  setModelInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addChip();
                  }
                }}
                className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
              />
              <button
                type="button"
                data-testid="provider-dialog-model-add"
                onClick={addChip}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                Add
              </button>
              <button
                type="button"
                data-testid="provider-dialog-fetch"
                disabled={row === null || busy !== null}
                title={row === null ? "Save the provider first, then fetch" : "Load stored models"}
                onClick={() => {
                  void fetchModels();
                }}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                {busy === "fetch" ? "Fetching…" : "Fetch models"}
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="provider-dialog-test"
              disabled={row === null || busy !== null}
              title={row === null ? "Save the provider first, then test" : "Prove the key live"}
              onClick={() => {
                void testConnection();
              }}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              data-testid="provider-dialog-cancel"
              onClick={onClose}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="provider-dialog-save"
              disabled={!valid}
              onClick={() => {
                void save();
              }}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
