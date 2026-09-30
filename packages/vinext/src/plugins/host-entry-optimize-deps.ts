import fs from "node:fs";
import path from "pathslash";
import { parseAst, type ESTree } from "vite";
import { packageNameFromSpecifier } from "../utils/package-name.js";
import { canonicalizeFilePath, NODE_MODULES_PATH_RE } from "../utils/path.js";
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
 * Includes use Vite's nested `owner > dependency` form so each dependency
 * resolves from the adapter package, as the discovered import would, rather
 * than from the project root. Dependencies that resolve outside node_modules
 * (linked or workspace packages) are skipped because Vite does not optimize
 * them on discovery either.
 *
 * Only relative imports inside the entry's own package are followed. Type-only
 * imports, builtins, protocol ids, package imports, and imports of the owning
 * package itself are skipped.
 */
export function collectHostEntryOptimizeDepsIncludes(entry: string, root: string): string[] {
  const realEntry = canonicalizeFilePath(entry);
  const owner = findOwningPackage(realEntry);
  // Vite resolves the nested owner from the root and silently falls back to
  // the root for the dependency when that fails, so the owner must resolve to
  // this entry's own package.
  if (!owner || findInstalledPackageDir(canonicalizeFilePath(root), owner.name) !== owner.dir) {
    return [];
  }

  const includes = new Set<string>();
  const seen = new Set<string>();
  const pending = [realEntry];
  while (pending.length > 0 && seen.size < MAX_HOST_ENTRY_FILES) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const lang = scriptParserLanguage(file);
    if (!lang || findOwningPackage(file)?.name !== owner.name) continue;
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
      if (!packageName || packageName === owner.name) continue;
      const packageDir = findInstalledPackageDir(path.dirname(file), packageName);
      if (packageDir && NODE_MODULES_PATH_RE.test(packageDir)) {
        includes.add(`${owner.name} > ${specifier}`);
      }
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
 * Find the package that owns `file`. Nameless manifests (for example a
 * `{ "type": "module" }` marker in a dist directory) are skipped.
 */
function findOwningPackage(file: string): { name: string; dir: string } | null {
  let directory = path.dirname(file);
  while (true) {
    const packageJsonPath = path.join(directory, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const name = readJsonFile<{ name?: unknown }>(packageJsonPath)?.name;
      if (typeof name === "string" && name) return { name, dir: directory };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Find the real directory that `packageName` resolves to from `directory`,
 * walking up through node_modules directories like Node and Vite do.
 */
function findInstalledPackageDir(directory: string, packageName: string): string | null {
  while (true) {
    const packageDir = path.join(directory, "node_modules", packageName);
    if (fs.existsSync(path.join(packageDir, "package.json"))) {
      return canonicalizeFilePath(packageDir);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
