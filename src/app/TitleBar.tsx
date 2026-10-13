/**
 * Custom window titlebar (Task 029 follow-up, B01). Rendered when the Tauri
 * window sets `decorations: false` (`src-tauri/tauri.conf.json`) so the frame
 * is ours: 32px bar, drag region, 46×32 caption buttons.
 *
 * Window controls resolve through a DYNAMIC import only — a static import of
 * `@tauri-apps/api/window` breaks mock/web boot because vite.config.ts
 * aliases only `core` and `event` to `mock-tauri.ts`. Buttons render always;
 * without a Tauri runtime each click is a silent no-op.
 */
import { Minus, Square, X } from "lucide-react";

interface TitleBarProps {
  /** Current thread/view label shown beside the app name. `| undefined`
   *  because the shell passes `title ?? "New chat"`-style values through —
   *  exactOptionalPropertyTypes pins that explicitness (tsconfig). */
  title?: string | undefined;
}

/** Minimize without ever throwing outside a Tauri runtime. */
async function minimizeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()
      .minimize()
      .catch(() => {});
  } catch {
    // No Tauri runtime (mock/web/tests) — the button is a silent no-op.
  }
}

/** Maximize/restore toggle without ever throwing outside a Tauri runtime.
 *  Exported so the F11 hotkey calls the same handler the caption button uses
 *  instead of clicking through the DOM (review 30 NIT). */
export async function toggleMaximizeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()
      .toggleMaximize()
      .catch(() => {});
  } catch {
    // No Tauri runtime (mock/web/tests) — the button is a silent no-op.
  }
}

/** Close without ever throwing outside a Tauri runtime. */
async function closeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()
      .close()
      .catch(() => {});
  } catch {
    // No Tauri runtime (mock/web/tests) — the button is a silent no-op.
  }
}

const CAPTION_BUTTON =
  "flex w-[46px] h-8 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground";

export function TitleBar({ title }: TitleBarProps): React.JSX.Element {
  return (
    <div
      data-testid="app-titlebar"
      data-tauri-drag-region
      className="flex h-8 w-full shrink-0 select-none items-center gap-2 bg-background pl-3 text-xs text-foreground"
    >
      <span className="font-semibold text-foreground">Clauro</span>
      {title !== undefined && title.length > 0 && (
        <span className="truncate text-muted-foreground">{title}</span>
      )}
      <span data-tauri-drag-region className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => {
            void minimizeWindow();
          }}
          className={CAPTION_BUTTON}
        >
          <Minus size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => {
            void toggleMaximizeWindow();
          }}
          className={CAPTION_BUTTON}
        >
          <Square size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => {
            void closeWindow();
          }}
          className={`${CAPTION_BUTTON} hover:bg-destructive hover:text-destructive-foreground`}
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
