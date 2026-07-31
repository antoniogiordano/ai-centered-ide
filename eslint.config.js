import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/out/**",
      "**/release/**",
      "fixtures/**",
      "spikes/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
  {
    files: ["apps/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@ai-ide/storage",
                "@ai-ide/workspace",
                "@ai-ide/tools",
                "@ai-ide/agent",
                "@ai-ide/provider",
              ],
              message:
                "Renderer must not import privileged packages; use IPC bridge only.",
            },
          ],
        },
      ],
    },
  },
);
