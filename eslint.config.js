import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.claude/**",
      "**/.agents/**",
      "**/.remember/**",
      "**/node_modules/**"
    ]
  },
  {
    rules: {
      // Allow `const { id, ...rest } = obj` to omit a key without flagging `id` as unused, and
      // honor the `_`-prefix convention used across the codebase for intentional-unused params/vars.
      "@typescript-eslint/no-unused-vars": ["error", {
        ignoreRestSiblings: true,
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }]
    }
  }
);
