import fs from "node:fs";
import path from "pathslash";
import { parseAst, type ESTree } from "vite";
import { packageNameFromSpecifier } from "../utils/package-name.js";
import { readJsonFile } from "../utils/safe-json-file.js";
import { scriptParserLanguage } from "./ast-utils.js";

// Adapter Worker entries are small module graphs. The cap only bounds startup
// work if an entry unexpectedly reaches a large part of its package.
const MAX_HOST_ENTRY_FILES = 64;

/**
 * Collect the bare imports reachable from an adapter-owned multi-stage entry.
 *
 * The host-entry transform appends a re-export of this entry, so Vite's
 * dependency scanner never sees its imports. The optimizer then discovers them
 * only when the host first imports the Worker graph, re-bundles, and reloads.
 * Returning them as optional includes makes the first optimize final.
 *
 * Only relative imports inside the entry's own package are followed. Type-only
 * imports, builtins, protocol ids, package imports, and imports of the owning
 * package itself are skipped.
 */
export function collectHostEntryOptimizeDepsIncludes(entry: string): string[] {
  const owner = findOwningPackageName(entry);
  if (!owner) return [];

  const includes = new Set<string>();
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0 && seen.size < MAX_HOST_ENTRY_FILES) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const lang = scriptParserLanguage(file);
    if (!lang || findOwningPackageName(file) !== owner) continue;
    let ast: ESTree.Program;
    try {
      ast = parseAst(fs.readFileSync(file, "utf-8"), { lang });
    } catch {
      continue;
    }

    for (const statement of ast.body) {
      if (!isRuntimeModuleDeclaration(statement)) continue;
      const specifier = statement.source.value;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        pending.push(path.resolve(path.dirname(file), specifier));
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName && packageName !== owner) includes.add(specifier);
    }
  }
  return [...includes];
}

type ModuleDeclarationWithSource = (
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration
) & { source: ESTree.StringLiteral };

function isRuntimeModuleDeclaration(
  statement: ESTree.Program["body"][number],
): statement is ModuleDeclarationWithSource {
  if (statement.type === "ImportDeclaration") {
    return (
      statement.importKind !== "type" &&
      (statement.specifiers.length === 0 ||
        statement.specifiers.some(
          (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
        ))
    );
  }
  if (statement.type === "ExportNamedDeclaration") {
    return (
      statement.source !== null &&
      statement.exportKind !== "type" &&
      (statement.specifiers.length === 0 ||
        statement.specifiers.some((specifier) => specifier.exportKind !== "type"))
    );
  }
  return statement.type === "ExportAllDeclaration" && statement.exportKind !== "type";
}

/**
 * Find the name of the package that owns `file`. Nameless manifests (for
 * example a `{ "type": "module" }` marker in a dist directory) are skipped.
 */
function findOwningPackageName(file: string): string | null {
  let directory = path.dirname(file);
  while (true) {
    const packageJsonPath = path.join(directory, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const name = readJsonFile<{ name?: unknown }>(packageJsonPath)?.name;
      if (typeof name === "string" && name) return name;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
