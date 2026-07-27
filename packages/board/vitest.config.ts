import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // `index.ts` is a re-export barrel with no logic of its own.
      exclude: ["src/index.ts"],
      // The board is the only record of the work — a drop here means an untested write path, which
      // is how notes and criteria have gone missing before. Branches lag the other three: the
      // remaining gap is in the legacy markdown paths (`removeSectionLine` and the `.md` fallbacks
      // in board-model/managed-block), which only a not-yet-migrated board still exercises.
      thresholds: { statements: 90, lines: 90, functions: 90, branches: 75 },
    },
  },
});
