import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Browser harness (UI-GUIDE) + mock mode (Task 029): `vite --mode browser`
  // and `vite --mode mock` resolve the Tauri API modules to
  // `src/dev/mock-tauri.ts`, so the same <App/> renders without a runtime.
  // Production builds, `tauri dev`, and vitest (mode "test") never see the alias.
  const browserMocks =
    mode === "browser" || mode === "mock"
      ? {
          "@tauri-apps/api/core": fileURLToPath(
            new URL("./src/dev/mock-tauri.ts", import.meta.url),
          ),
          "@tauri-apps/api/event": fileURLToPath(
            new URL("./src/dev/mock-tauri.ts", import.meta.url),
          ),
        }
      : {};
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // Mirrors tsconfig.json `paths` so vitest and the build resolve `@/*`.
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        ...browserMocks,
      },
    },
    // Cold-start fix (Task 030): pre-bundle the stable heavy graph at server
    // start instead of on first paint. Without this, the first load of
    // App.tsx (~40s measured) blocks behind on-demand dep optimization of
    // radix/marked/dompurify/zod/sucrase, and the total cold launch lands in
    // the minutes on a loaded box. Cached in node_modules/.vite afterwards.
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "zustand",
        "clsx",
        "tailwind-merge",
        "class-variance-authority",
        "lucide-react",
        "marked",
        "dompurify",
        "zod",
        "@radix-ui/react-avatar",
        "@radix-ui/react-collapsible",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-label",
        "@radix-ui/react-progress",
        "@radix-ui/react-scroll-area",
        "@radix-ui/react-select",
        "@radix-ui/react-separator",
        "@radix-ui/react-slot",
        "@radix-ui/react-tooltip",
      ],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      // 4. transform the shell graph at ready, not at first paint (Task 030).
      warmup: {
        clientFiles: ["./src/main.tsx", "./src/app/App.tsx", "./src/styles.css"],
      },
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
