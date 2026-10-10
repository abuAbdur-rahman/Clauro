/**
 * Settings dialog (UI-GUIDE §7, DESIGN §2.6). shadcn Dialog, not a page:
 * left nav with sections, right pane with its own scroll — the dialog
 * itself never scrolls. Esc closes (Dialog default). v1 ships three real
 * sections (Providers, Appearance, Data); the rest arrive with their owners.
 */
import { useState } from "react";
import { Download, Moon, Sun, MonitorSmartphone } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ProvidersView } from "../providers/ProvidersView";
import {
  containsKeyMaterial,
  threadToHtml,
  threadToMarkdown,
  type ExportBlock,
} from "../retention/retention";
import { transcriptRead } from "../turn/turn";
import type { RenderRow } from "../transcript/types";
import { useTheme } from "../shell/usetheme";
import { useSettingsStore, type SettingsSection } from "../shell/settings";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Data" },
];

export function SettingsDialog({ threadId }: { threadId: string }): React.JSX.Element {
  const open = useSettingsStore((s) => s.open);
  const section = useSettingsStore((s) => s.section);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const setSection = useSettingsStore((s) => s.openSettings);

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
          <nav aria-label="Settings sections" className="w-[200px] shrink-0 overflow-y-auto border-r border-border p-2">
            <DialogHeader className="px-2 pb-2 text-left">
              <DialogTitle className="text-sm">Settings</DialogTitle>
            </DialogHeader>
            <ul className="flex flex-col gap-1">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={s.id === section ? "page" : undefined}
                    onClick={() => {
                      setSection(s.id);
                    }}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${
                      s.id === section ? "bg-accent font-medium" : ""
                    }`}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {section === "providers" && <ProvidersView />}
            {section === "appearance" && <AppearancePane />}
            {section === "data" && <DataPane threadId={threadId} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppearancePane(): React.JSX.Element {
  const { mode, density, setMode, setDensity } = useTheme();
  return (
    <div>
      <h2 className="text-sm font-medium">Appearance</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Theme follows the device unless pinned. White surfaces exist only in light mode.
      </p>
      <div className="mt-4">
        <p className="text-xs font-medium">Theme</p>
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Theme">
          {(
            [
              { value: "system", label: "System", icon: MonitorSmartphone },
              { value: "light", label: "Light", icon: Sun },
              { value: "dark", label: "Dark", icon: Moon },
            ] as const
          ).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => {
                setMode(value);
              }}
              className={`flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent ${
                mode === value ? "border-ring font-medium" : ""
              }`}
            >
              <Icon size={16} strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4">
        <p className="text-xs font-medium">Density</p>
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Density">
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
              className={`rounded-md border border-border px-3 py-2 text-xs hover:bg-accent ${
                density === value ? "border-ring font-medium" : ""
              }`}
            >
              {label}
            </button>
          ))}
        </div>
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

function DataPane({ threadId }: { threadId: string }): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null);

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
    <div>
      <h2 className="text-sm font-medium">Data</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Export this thread. Thinking blocks are stripped; anything shaped like a secret blocks
        the write.
      </p>
      {status && (
        <p role="status" className="mt-2 text-xs text-amber-400">
          {status}
        </p>
      )}
      <div className="mt-4 flex gap-2">
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
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Deleting threads arrives with the retention surfaces (019) — nothing here deletes.
      </p>
    </div>
  );
}
