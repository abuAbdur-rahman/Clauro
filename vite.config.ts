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
  // Browser harness (UI-GUIDE): `vite --mode browser` resolves the Tauri API
  // modules to `src/dev/mock-tauri.ts`, so the same <App/> renders without a
  // runtime. Production builds, `tauri dev`, and vitest (mode "test") never
  // see the alias.
  const browserMocks =
    mode === "browser"
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

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
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
