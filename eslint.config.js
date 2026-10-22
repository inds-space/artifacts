import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "worker-configuration.d.ts",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  { files: ["scripts/**/*.mjs"], extends: [tseslint.configs.disableTypeChecked], languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } } },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
);
