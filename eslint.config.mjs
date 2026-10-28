import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["scripts/**/*.ts", "scripts/**/*.tsx"],
    rules: {
      // Verify scripts use condition ? pass() : fail(); both arms do work.
      // Other unused expressions still fail lint.
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not ours: a Python virtualenv that ships bundled JavaScript. It was
    // contributing 11 of the 15 errors, which is how a lint run stops being read.
    ".nsp/**",
    // Vendored MIT dependency; its local patch is verified by security:patches.
    "vendor/**",
    // Generated locally and ignored by git (see .gitignore).
    "output/**",
    "tmp/**",
  ]),
]);

export default eslintConfig;
