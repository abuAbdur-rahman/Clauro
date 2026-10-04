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
    ignores: ["dist/"],
  },
);
