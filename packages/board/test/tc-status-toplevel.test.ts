/**
 * Campaign rule 8 / delta 10 (octoshell-0-1-1): tc-status.ts must add no bytes to the octograph payload, which
 * bundles `@octoshell/board` without a `sideEffects` flag. Nothing reaches tc-status.ts from BoardModel, and its
 * top level may hold only imports, type declarations and function declarations (literals and regex literals live
 * inside functions or are `export const` of a literal; no spread, no `new X(ident)`, no top-level call).
 * `graph-payload.mjs --verify` is the real gate; this names the cause when it goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const SRC = resolve(__dirname, "../src");
const source = (name: string): ts.SourceFile => ts.createSourceFile(name, readFileSync(resolve(SRC, name), "utf8"), ts.ScriptTarget.ES2022, true);

describe("tc-status.ts stays tree-shakeable", () => {
  it("has only imports, types and function declarations at its top level", () => {
    const offenders = source("tc-status.ts").statements
      .filter((s) => !(ts.isImportDeclaration(s) || ts.isFunctionDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)))
      .map((s) => `${ts.SyntaxKind[s.kind]}: ${s.getText().slice(0, 60)}`);
    expect(offenders).toEqual([]);
  });

  it("is not imported by anything BoardModel reaches", () => {
    for (const name of ["board-model.ts", "tc-io.ts", "test-cases.ts", "write.ts", "validate.ts", "types.ts", "managed-block.ts", "entity-schema.ts", "slug.ts", "plan-review.ts"]) {
      expect(readFileSync(resolve(SRC, name), "utf8"), name).not.toMatch(/tc-status/);
    }
  });
});
