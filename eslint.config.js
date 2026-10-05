import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // AGENTS.md §5: no `any`, enforced mechanically — not a convention.
      "@typescript-eslint/no-explicit-any": "error",
      // AGENTS.md §5: no `console.log` in committed code. Logs are files.
      "no-console": "error",
    },
  },
  {
    // The frame runtime is shipped to the sandbox as raw text and is never
    // bundled or typechecked (`checkJs` is off for it). It is deliberately
    // plain ES5-ish script code — inside the frame there is no module system,
    // no bundler and no `import` of anything — so the type-aware rules have
    // nothing useful to say about it and `no-undef` needs the browser globals
    // it actually runs against.
    files: ["src/artifact/frame-runtime.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        self: "readonly",
        Node: "readonly",
        MessageEvent: "readonly",
        MessagePort: "readonly",
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },
  {
    ignores: ["dist/"],
  },
);
