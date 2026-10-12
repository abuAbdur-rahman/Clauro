/**
 * Settings dialog (UI-GUIDE §7, DESIGN §2.6). shadcn Dialog, not a page:
 * left nav (220px) with search + sections, right pane with its own scroll —
 * the dialog itself never scrolls. Esc closes (Dialog default). Eight pages
 * mirror the prototype (index.html:526-551): General, Appearance, Providers,
 * Models, Memory, Data, Shortcuts, About.
 *
 * Self-containment rule: this dialog never imports `@/mock/*` (real boot
 * must stay mock-free) and never delegates to owner views — ProvidersView
 * lives in the App providers surface; here Providers is a store-driven note.
 * Seed-derived tables (accents, shortcuts) are local copies, not imports.
 */
import { useEffect, useState } from "react";
import {
  Brain,
  Check,
  Cpu,
  Database,
  Download,
  Info,
  Keyboard,
  LoaderCircle,
  Moon,
  Palette as PaletteIcon,
  Pencil,
  Plug,
  Settings as SettingsIcon,
  Sun,
  MonitorSmartphone,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  containsKeyMaterial,
  threadToHtml,
  threadToMarkdown,
  type ExportBlock,
} from "../retention/retention";
import { transcriptRead } from "../turn/turn";
import type { RenderRow } from "../transcript/types";
import { useThreadStore } from "../catalogue/thread";
import { providerList, providerModelsEnriched, type EnrichedModel } from "../providers/providers";
import { useTheme } from "../shell/usetheme";
import { useSettingsStore, type SettingsSection } from "../shell/settings";

const SECTIONS: { id: SettingsSection; label: string; keywords: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", keywords: "display name language send auto-compact context bar system prompt", icon: SettingsIcon },
  { id: "appearance", label: "Appearance", keywords: "theme accent font size density group dates preview", icon: PaletteIcon },
  { id: "providers", label: "Providers", keywords: "api keys endpoints add provider", icon: Plug },
  { id: "models", label: "Models", keywords: "default model visible temperature max tokens top p parameters", icon: Cpu },
  { id: "memory", label: "Memory", keywords: "remember enable ask search add edit delete clear export", icon: Brain },
  { id: "data", label: "Data", keywords: "export import clear chats reset storage", icon: Database },
  { id: "shortcuts", label: "Shortcuts", keywords: "keyboard ctrl palette sidebar compact maximize", icon: Keyboard },
  { id: "about", label: "About", keywords: "version status changelog licenses", icon: Info },
];

/** Section icons, shared with the command palette's Settings group so both
 *  surfaces name pages the same way (html PAGES, index.html:332). */
export const SETTINGS_SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  general: SettingsIcon,
  appearance: PaletteIcon,
  providers: Plug,
  models: Cpu,
  memory: Brain,
  data: Database,
  shortcuts: Keyboard,
  about: Info,
};

/** kbd chip (html;font:12px mono,border-bottom-width:2px). Copy sits on
 *  bg-background so muted-foreground keeps its ≥4.5:1 contrast. */
export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-b-2 border-border bg-background px-1.5 py-px font-mono text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

/** Accent swatches. Values mirror the prototype palette verbatim (local copy:
 *  real code must never import `@/mock/seed`). */
const ACCENTS: readonly (readonly [string, string])[] = [
  ["Clay", "#c96442"],
  ["Blue", "#0067c0"],
  ["Green", "#0f7b0f"],
  ["Purple", "#7a42d6"],
  ["Pink", "#c239b3"],
  ["Graphite", "#5c5c5c"],
];

/** Shortcut table. Rows mirror the prototype KEYS verbatim (local copy). */
const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["Ctrl+K", "Open command palette"],
  ["Ctrl+N", "New chat"],
  ["Ctrl+,", "Open Settings"],
  ["Ctrl+B", "Toggle sidebar"],
  ["Ctrl+Shift+A", "Toggle artifact panel"],
  ["Ctrl+Shift+C", "Compact conversation"],
  ["Esc", "Close overlay, else stop streaming"],
  ["F11", "Toggle maximize icon"],
];

function useLocalPref(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v: string) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        // Private-mode storage failure: prefs degrade to memory-only.
      }
    },
  ];
}

function useLocalFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [raw, setRaw] = useLocalPref(key, fallback ? "1" : "0");
  return [raw === "1", (v: boolean) => {
    setRaw(v ? "1" : "0");
  }];
}

function Row({
  label,
  desc,
  query,
  fluid = false,
  children,
}: {
  label: string;
  desc?: string;
  query: string;
  /** Wide controls (theme tiles) take the free width like html `.rc.free`. */
  fluid?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const q = query.trim().toLowerCase();
  const hit = q !== "" && label.toLowerCase().includes(q);
  return (
    <div className={`flex items-center justify-between gap-4 rounded-md px-2 py-3 ${hit ? "bg-accent" : ""}`}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>}
      </div>
      <div className={fluid ? "flex min-w-0 flex-1 items-center justify-end" : "flex w-[260px] shrink-0 items-center justify-end gap-2"}>
        {children}
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative h-5 w-10 shrink-0 rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
        checked ? "border-primary bg-primary" : "border-muted-foreground bg-background"
      }`}
    >
      <span
        className={`absolute top-[3px] size-3 rounded-full transition-all ${
          checked ? "left-[23px] bg-primary-foreground" : "left-[3px] bg-muted-foreground"
        }`}
      />
    </button>
  );
}

export function SettingsDialog({ threadId }: { threadId: string }): React.JSX.Element {
  const open = useSettingsStore((s) => s.open);
  const section = useSettingsStore((s) => s.section);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const setSection = useSettingsStore((s) => s.openSettings);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open ]);

  const q = query.trim().toLowerCase();
  const visibleSections = SECTIONS.filter(
    (s) =>
      q === "" ||
      s.label.toLowerCase().includes(q) ||
      s.keywords.includes(q),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSettings();
      }}
    >
      <DialogContent
        aria-label="Settings"
        // sm: prefix required: the vendored content caps at sm:max-w-lg and
        // responsive variants beat unprefixed utilities in the cascade.
        className="h-[min(640px,calc(100dvh-2rem))] w-[min(920px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[min(920px,calc(100vw-2rem))]"
      >
        <div className="flex h-full min-h-0">
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <nav aria-label="Settings sections" className="w-[220px] shrink-0 overflow-y-auto border-r border-border bg-muted/40 p-3">
            <div className="pb-2">
              <input
                aria-label="Search settings"
                placeholder="Search settings"
                autoComplete="off"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <ul className="flex flex-col gap-0.5" data-testid="settings-nav">
              {visibleSections.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={s.id === section ? "page" : undefined}
                    onClick={() => {
                      setSection(s.id);
                    }}
                    className={`flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm hover:bg-accent ${
                      s.id === section ? "bg-accent font-semibold" : ""
                    }`}
                  >
                    <s.icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                    {s.label}
                  </button>
                </li>
              ))}
              {visibleSections.length === 0 && (
                <li className="px-2.5 py-2 text-xs text-muted-foreground">No matches</li>
              )}
            </ul>
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            {section === "general" && <GeneralPane query={q} />}
            {section === "appearance" && <AppearancePane query={q} />}
            {section === "providers" && <ProvidersPane />}
            {section === "models" && <ModelsPane query={q} />}
            {section === "memory" && <MemoryPane query={q} />}
            {section === "data" && <DataPane threadId={threadId} query={q} />}
            {section === "shortcuts" && <ShortcutsPane />}
            {section === "about" && <AboutPane />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GeneralPane({ query }: { query: string }): React.JSX.Element {
  const [name, setName] = useLocalPref("clauro.prefs.name", "");
  const [sendWith, setSendWith] = useLocalPref("clauro.prefs.sendWith", "enter");
  const [sysPrompt, setSysPrompt] = useLocalPref("clauro.prefs.sysPrompt", "");
  const [autoCompact, setAutoCompact] = useLocalFlag("clauro.prefs.autoCompact", true);
  const [showContext, setShowContext] = useLocalFlag("clauro.prefs.showContext", true);
  return (
    <div data-testid="settings-page-general">
      <h2 className="mb-4 text-xl font-semibold">General</h2>
      <div className="divide-y divide-border">
        <Row label="Display name" desc="Used in the greeting and profile" query={query}>
          <input
            aria-label="Display name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Row>
        <Row label="Language" query={query}>
          <select
            aria-label="Language"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option>English</option>
            <option disabled>Español (soon)</option>
            <option disabled>Français (soon)</option>
          </select>
        </Row>
        <Row label="Send message with" query={query}>
          <select
            aria-label="Send message with"
            value={sendWith}
            onChange={(e) => {
              setSendWith(e.target.value);
            }}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="enter">Enter</option>
            <option value="ctrl">Ctrl+Enter</option>
          </select>
        </Row>
        <Row label="Auto-compact when context is full" desc="Compacts automatically above 85%" query={query}>
          <Toggle checked={autoCompact} onChange={setAutoCompact} label="Auto-compact" />
        </Row>
        <Row label="Show context usage bar" query={query}>
          <Toggle checked={showContext} onChange={setShowContext} label="Show context bar" />
        </Row>
        <Row label="Default system prompt" desc="Cosmetic in this prototype" query={query}>
          <textarea
            aria-label="Default system prompt"
            rows={4}
            placeholder="You are a helpful assistant."
            value={sysPrompt}
            onChange={(e) => {
              setSysPrompt(e.target.value);
            }}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Row>
      </div>
    </div>
  );
}

function AppearancePane({ query }: { query: string }): React.JSX.Element {
  const { mode, density, setMode, setDensity } = useTheme();
  const [accent, setAccent] = useLocalPref("clauro.theme.accent", "#c96442");
  const [fontSize, setFontSize] = useLocalPref("clauro.prefs.fontSize", "15");
  const [groupDates, setGroupDates] = useLocalFlag("clauro.prefs.groupDates", true);

  function pickAccent(value: string): void {
    setAccent(value);
    try {
      document.documentElement.dataset.accent = value;
    } catch {
      // Non-DOM test hosts: persistence still holds.
    }
  }

  return (
    <div data-testid="settings-page-appearance">
      <h2 className="mb-4 text-xl font-semibold">Appearance</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Theme follows the device unless pinned. White surfaces exist only in light mode.
      </p>
      <div className="divide-y divide-border">
        <Row label="Theme" desc="Applies instantly" query={query} fluid>
          <div className="flex gap-2.5" role="radiogroup" aria-label="Theme">
            {(
              [
                { value: "system", label: "System", icon: MonitorSmartphone, preview: "system" },
                { value: "light", label: "Light", icon: Sun, preview: "light" },
                { value: "dark", label: "Dark", icon: Moon, preview: "dark" },
              ] as const
            ).map(({ value, label, icon: Icon, preview }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => {
                  setMode(value);
                }}
                className={`flex w-[110px] flex-col items-center gap-1.5 rounded-lg border-2 p-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                  mode === value ? "border-ring font-medium" : "border-border"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-10 w-full rounded border border-border ${
                    preview === "light"
                      ? "bg-white"
                      : preview === "dark"
                        ? "bg-neutral-900"
                        : "bg-gradient-to-r from-white from-50% to-neutral-900 to-50%"
                  }`}
                />
                <span className="flex items-center gap-1">
                  <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                  {label}
                </span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Accent color" query={query} fluid>
          <div className="flex gap-2">
            {ACCENTS.map(([name, value]) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                title={name}
                aria-pressed={accent === value}
                onClick={() => {
                  pickAccent(value);
                }}
                style={{ background: value }}
                className={`grid size-7 place-items-center rounded-full border-2 text-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                  accent === value ? "border-ring" : "border-transparent"
                }`}
              >
                {accent === value ? <Check size={14} strokeWidth={2.5} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Chat font size" query={query}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={13}
              max={18}
              step={1}
              aria-label="Chat font size"
              value={fontSize}
              onChange={(e) => {
                setFontSize(e.target.value);
              }}
            />
            <span className="w-10 text-right text-xs">{fontSize}px</span>
          </div>
        </Row>
        <div className="px-2 py-2 text-xs text-muted-foreground" style={{ fontSize: `${fontSize}px` }}>
          The quick brown fox jumps over the lazy dog.
        </div>
        <Row label="Message density" query={query}>
          <div className="inline-flex overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Density">
            {(
              [
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={density === value}
                onClick={() => {
                  setDensity(value);
                }}
                className={`px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none ${
                  density === value ? "bg-primary font-medium text-primary-foreground" : "hover:bg-accent"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Show chat grouping by date" desc="Cosmetic" query={query}>
          <Toggle checked={groupDates} onChange={setGroupDates} label="Group by date" />
        </Row>
      </div>
    </div>
  );
}

function ProvidersPane(): React.JSX.Element {
  const openSettings = useSettingsStore((s) => s.openSettings);
  return (
    <div data-testid="settings-page-providers">
      <h2 className="mb-4 text-xl font-semibold">Providers</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Bring your own API keys. Endpoints and keys are managed in the Providers surface; this
        dialog stays self-contained and only routes there through the settings store.
      </p>
      <div className="mt-4">
        <button
          type="button"
          onClick={() => {
            openSettings("providers");
          }}
          className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground hover:opacity-90"
        >
          Open Providers
        </button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Keys are stored on this device only.
      </p>
    </div>
  );
}

interface ModelRow {
  key: string;
  id: string;
  provider: string;
  context: string;
}

function ModelsPane({ query }: { query: string }): React.JSX.Element {
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useLocalPref("clauro.prefs.defaultModel", "");
  const [hiddenRaw, setHiddenRaw] = useLocalPref("clauro.models.hidden", "{}");
  const [temperature, setTemperature] = useLocalPref("clauro.models.temperature", "0.7");
  const [maxTokens, setMaxTokens] = useLocalPref("clauro.models.maxTokens", "2048");
  const [topP, setTopP] = useLocalPref("clauro.models.topP", "1");

  useEffect(() => {
    // Same cancelled-through-a-call shape as App.tsx: property narrowing
    // would otherwise conclude the flag never changes and flag the guards.
    const cancelled = { value: false };
    void (async () => {
      try {
        const providers = await providerList();
        const all: ModelRow[] = [];
        for (const p of providers) {
          let enriched: EnrichedModel[] = [];
          try {
            enriched = await providerModelsEnriched(p.id);
          } catch {
            enriched = [];
          }
          for (const m of enriched) {
            all.push({
              key: `${p.id}:${m.id}`,
              id: m.display_name || m.id,
              provider: p.display_name,
              context: m.context_window === null ? "—" : `${String(Math.round(m.context_window / 1000))}k`,
            });
          }
        }
        if (!cancelled.value) {
          setRows(all);
          if (all.length === 0) setNotice("No models. Add a provider in Settings → Providers");
        }
      } catch (e) {
        if (!cancelled.value) {
          setRows([]);
          setNotice(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled.value = true;
    };
  }, []);

  let hidden: Record<string, boolean> = {};
  try {
    const parsed: unknown = JSON.parse(hiddenRaw);
    if (typeof parsed === "object" && parsed !== null) hidden = parsed as Record<string, boolean>;
  } catch {
    hidden = {};
  }

  function toggleVisible(key: string, visible: boolean): void {
    setHiddenRaw(JSON.stringify({ ...hidden, [key]: !visible }));
  }

  return (
    <div data-testid="settings-page-models">
      <h2 className="mb-4 text-xl font-semibold">Models</h2>
      <div className="divide-y divide-border">
        <Row label="Default model" desc="Used for new chats" query={query}>
          <select
            aria-label="Default model"
            value={defaultModel}
            onChange={(e) => {
              setDefaultModel(e.target.value);
            }}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">Select a model</option>
            {(rows ?? []).map((r) => (
              <option key={r.key} value={r.key}>
                {r.id}
              </option>
            ))}
          </select>
        </Row>
      </div>
      {rows === null && (
        <p className="flex items-center gap-2 px-2 py-6 text-xs text-muted-foreground">
          <LoaderCircle size={14} strokeWidth={1.75} aria-hidden="true" className="animate-spin" />
          Loading models…
        </p>
      )}
      {rows !== null && rows.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <Cpu size={20} strokeWidth={1.5} aria-hidden="true" className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{notice ?? "No models"}</p>
        </div>
      )}
      {(rows ?? []).length > 0 && (
        <table className="mt-2 w-full text-left text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Name</th>
              <th className="py-1 pr-2 font-medium">Provider</th>
              <th className="py-1 pr-2 font-medium">Context</th>
              <th className="py-1 font-medium">Visible</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="py-1.5 pr-2">{r.id}</td>
                <td className="py-1.5 pr-2 text-muted-foreground">{r.provider}</td>
                <td className="py-1.5 pr-2 text-muted-foreground">{r.context}</td>
                <td className="py-1.5">
                  <Toggle
                    checked={!hidden[r.key]}
                    onChange={(v) => {
                      toggleVisible(r.key, v);
                    }}
                    label={`Visible ${r.id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-4 rounded-md border border-border p-3">
        <p className="text-xs font-medium">
          Parameters <span className="font-normal text-muted-foreground">(cosmetic)</span>
        </p>
        {(
          [
            ["Temperature", "0", "2", "0.1", temperature, setTemperature],
            ["Max output tokens", "256", "8192", "256", maxTokens, setMaxTokens],
            ["Top P", "0", "1", "0.05", topP, setTopP],
          ] as const
        ).map(([label, min, max, step, value, set]) => (
          <div key={label} className="mt-2 flex items-center justify-between gap-4 text-xs">
            <span>{label}</span>
            <span className="flex items-center gap-2">
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                aria-label={label}
                value={value}
                onChange={(e) => {
                  set(e.target.value);
                }}
              />
              <span className="w-11 text-right">{value}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface MemoryEntry {
  id: string;
  text: string;
}

function MemoryPane({ query }: { query: string }): React.JSX.Element {
  const [enabled, setEnabled] = useLocalFlag("clauro.memory.enabled", true);
  const [askSave, setAskSave] = useLocalFlag("clauro.memory.askSave", false);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // No memory store exists in src/features yet: this list is honest local
  // state. It starts empty and never pretends to persist across reloads.

  const q = search.trim().toLowerCase();
  const shown = entries.filter((m) => q === "" || m.text.toLowerCase().includes(q));

  function addMemory(): void {
    const text = draft.trim();
    if (text === "") return;
    setEntries((prev) => [...prev, { id: `mem-${String(Date.now())}`, text }]);
    setDraft("");
  }

  return (
    <div data-testid="settings-page-memory">
      <h2 className="mb-4 text-xl font-semibold">Memory</h2>
      <div className="divide-y divide-border">
        <Row label="Enable memory" desc="Clauro can remember things you tell it" query={query}>
          <Toggle checked={enabled} onChange={setEnabled} label="Enable memory" />
        </Row>
        <Row label="Ask before saving" desc="You approve each memory" query={query}>
          <Toggle checked={askSave} onChange={setAskSave} label="Ask before saving" />
        </Row>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <input
          aria-label="Search memories"
          placeholder="Search memories"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex gap-2">
          <input
            aria-label="Add a memory"
            placeholder="Add a memory…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addMemory();
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={addMemory}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90"
          >
            Add memory
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {shown.map((m) =>
          editing === m.id ? (
            <div key={m.id} className="flex gap-2">
              <textarea
                aria-label="Edit memory"
                rows={2}
                value={editText}
                onChange={(e) => {
                  setEditText(e.target.value);
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const text = editText.trim();
                    if (text !== "") {
                      setEntries((prev) => prev.map((e) => (e.id === m.id ? { ...e, text } : e)));
                    }
                    setEditing(null);
                  }}
                  className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                  }}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <span className="min-w-0 truncate text-xs">{m.text}</span>
              <span className="flex shrink-0 gap-0.5">
                <button
                  type="button"
                  aria-label={`Edit memory ${m.text}`}
                  title="Edit memory"
                  onClick={() => {
                    setEditing(m.id);
                    setEditText(m.text);
                  }}
                  className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete memory ${m.text}`}
                  title="Delete memory"
                  onClick={() => {
                    setEntries((prev) => prev.filter((e) => e.id !== m.id));
                  }}
                  className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </div>
          ),
        )}
        {shown.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <Brain size={20} strokeWidth={1.5} aria-hidden="true" className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {entries.length === 0 ? "No memories yet. Add one above." : "No memories match."}
            </p>
          </div>
        )}
      </div>
      {note && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {note}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => {
            setNote("Export is not wired yet — memories stay on this device.");
          }}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          Export memories
        </button>
        <button
          type="button"
          onClick={() => {
            setEntries([]);
            setEditing(null);
            setNote("Cleared all memories.");
          }}
          className="rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-accent"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}

/** Flatten one contract row to exportable text. Thinking never survives —
 *  `stripThinkingForExport` enforces that downstream too; this mapper only
 *  chooses the readable field per kind. */
export function rowToExportBlock(row: RenderRow): ExportBlock {
  const block = row.block;
  switch (block.kind) {
    case "text":
      return { kind: "text", text: block.text };
    case "thinking":
      return { kind: "thinking", text: block.text };
    case "tool_use":
      return { kind: "tool_use", text: `${block.name} ${block.input_json}` };
    case "tool_result":
      return { kind: "tool_result", text: block.preview };
    case "artifact_ref":
      return { kind: "artifact_ref", text: block.title };
    case "question_card":
      return { kind: "question_card", text: block.prompt };
    case "summary":
      return { kind: "summary", text: block.text };
    case "compaction":
      return { kind: "compaction", text: block.provider_block_id };
    case "notice":
      return { kind: "notice", text: block.text };
  }
}

function storageBytes(): number {
  try {
    let chars = 0;
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i) ?? "";
      chars += key.length + (window.localStorage.getItem(key) ?? "").length;
    }
    return chars * 2;
  } catch {
    return 0;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DataPane({ threadId, query }: { threadId: string; query: string }): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null);
  const [used, setUsed] = useState(0);

  useEffect(() => {
    setUsed(storageBytes());
  }, [status]);

  async function exportAs(format: "md" | "html"): Promise<void> {
    setStatus(null);
    try {
      const rows = await transcriptRead(threadId);
      const blocks = rows.map(rowToExportBlock);
      const joined = blocks.map((b) => b.text ?? b.kind).join("\n");
      // The key-material scan blocks the write, not warns past it: an export
      // carrying a secret is worse than no export.
      if (containsKeyMaterial(joined)) {
        setStatus("Export blocked: the transcript looks like it contains key material.");
        return;
      }
      const title = `thread-${threadId}`;
      const body = format === "md" ? threadToMarkdown(title, blocks) : threadToHtml(title, blocks);
      const blob = new Blob([body], {
        type: format === "md" ? "text/markdown" : "text/html",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${String(blocks.length)} blocks.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div data-testid="settings-page-data">
      <h2 className="mb-4 text-xl font-semibold">Data</h2>
      <div className="divide-y divide-border">
        <Row label="Export this thread" desc="Thinking stripped; key-shaped content blocks the write" query={query}>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void exportAs("md");
              }}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent"
            >
              <Download size={16} strokeWidth={1.75} />
              Export Markdown
            </button>
            <button
              type="button"
              onClick={() => {
                void exportAs("html");
              }}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent"
            >
              <Download size={16} strokeWidth={1.75} />
              Export HTML
            </button>
          </span>
        </Row>
        <Row label="Import" desc="Restoring a previous export is not wired yet" query={query}>
          <input
            type="file"
            aria-label="Import"
            onChange={() => {
              setStatus("Import is not wired yet — nothing was read.");
            }}
            className="max-w-48 text-xs text-muted-foreground"
          />
        </Row>
        <Row label="Clear all chats" desc="Drops in-memory threads; providers and keys are kept" query={query}>
          <button
            type="button"
            onClick={() => {
              useThreadStore.getState().reset();
              setStatus("Cleared all chats.");
            }}
            className="rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-accent"
          >
            Clear
          </button>
        </Row>
        <Row label="Reset app" desc="Clears local settings and shows onboarding" query={query}>
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.clear();
              } catch {
                // Unrecoverable here; report below like every other failure.
              }
              setUsed(0);
              setStatus("Reset local settings.");
            }}
            className="rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-accent"
          >
            Reset
          </button>
        </Row>
      </div>
      {status && (
        <p role="status" className="mt-2 px-2 text-xs text-yellow-700 dark:text-amber-300">
          {status}
        </p>
      )}
      <div className="mt-3 px-2">
        <div className="text-xs text-muted-foreground">{formatBytes(used)} of local storage</div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${String(Math.min(100, (used / (5 * 1024 * 1024)) * 100))}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function ShortcutsPane(): React.JSX.Element {
  return (
    <div data-testid="settings-page-shortcuts">
      <h2 className="mb-4 text-xl font-semibold">Shortcuts</h2>
      {/* Prototype .tbl rhythm (index.html:232-233): 8px cells, bottom
          borders, 13px. Desc column keeps the app's muted table idiom. */}
      <table className="mt-3 w-full text-left text-[13px]">
        <tbody>
          {SHORTCUTS.map(([keys, desc]) => (
            <tr key={keys} className="border-b border-border">
              <td className="px-2 py-2 pr-4 whitespace-nowrap">
                {keys.split("+").map((k, i) => (
                  <span key={k}>
                    {i > 0 && <span className="text-muted-foreground"> + </span>}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </td>
              <td className="px-2 py-2 text-muted-foreground">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AboutPane(): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null);
  return (
    <div data-testid="settings-page-about">
      <h2 className="mb-4 text-xl font-semibold">About</h2>
      <div className="divide-y divide-border">
        <Row label="App name" query="">
          <span className="text-xs">Clauro</span>
        </Row>
        <Row label="Version" query="">
          <span className="text-xs">0.1.0-prototype</span>
        </Row>
        <Row label="Status" desc="UI prototype — no backend" query="">
          <span className="text-xs text-muted-foreground">Prototype</span>
        </Row>
        <Row label="Links" query="">
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setNote("Placeholder: Changelog");
              }}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              Changelog
            </button>
            <button
              type="button"
              onClick={() => {
                setNote("Placeholder: Licenses");
              }}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              Licenses
            </button>
          </span>
        </Row>
      </div>
      {note && (
        <p role="status" className="mt-2 px-2 text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

/** Search-matched snapshot for tests: which sections survive a query. */
export function filterSettingsSections(query: string): SettingsSection[] {
  const q = query.trim().toLowerCase();
  return SECTIONS.filter(
    (s) => q === "" || s.label.toLowerCase().includes(q) || s.keywords.includes(q),
  ).map((s) => s.id);
}

export const SETTINGS_SHORTCUTS: readonly (readonly [string, string])[] = SHORTCUTS;
