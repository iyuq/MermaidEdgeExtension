#!/usr/bin/env node
/**
 * Builds the extension into ./dist by copying source files and vendored
 * dependencies from node_modules. No bundler; the files are already
 * browser-ready.
 */
import { cp, mkdir, rm, stat, access, readdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const NODE_MODULES = join(ROOT, "node_modules");

const SOURCE_DIRS = ["background", "content", "popup", "icons"];
const SOURCE_FILES = ["manifest.json"];
const OWNED_LIB = ["lib/plantuml-encoder.js"];
const VENDOR = [
  { from: "mermaid/dist/mermaid.min.js", to: "lib/mermaid.min.js" },
];

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch { return false; }
}

async function requireNodeModules() {
  if (!(await exists(NODE_MODULES))) {
    console.error("node_modules not found. Run `npm install` first.");
    process.exit(1);
  }
}

async function requireFile(path, hint) {
  if (!(await exists(path))) {
    console.error(`Missing: ${path}\n${hint}`);
    process.exit(1);
  }
}

async function copyInto(src, distRelative) {
  const dest = join(DIST, distRelative);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}

async function main() {
  await requireNodeModules();

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const file of SOURCE_FILES) {
    await requireFile(join(ROOT, file), "Expected at repo root.");
    await copyInto(join(ROOT, file), file);
  }

  for (const dir of SOURCE_DIRS) {
    await requireFile(join(ROOT, dir), "Expected at repo root.");
    await copyInto(join(ROOT, dir), dir);
  }

  for (const file of OWNED_LIB) {
    await requireFile(join(ROOT, file), "Expected at repo root.");
    await copyInto(join(ROOT, file), file);
  }

  for (const { from, to } of VENDOR) {
    const src = join(NODE_MODULES, from);
    await requireFile(src, "Try `npm install` to populate node_modules.");
    await copyInto(src, to);
  }

  await minifyTree(DIST);

  console.log(`Built extension at ${DIST}`);
  console.log(`Load unpacked: select the dist/ folder.`);
}

// Minifies .js and .css files in the dist tree in place. Skips files whose
// names end in ".min.js" (already minified upstream — re-minifying is fine
// but wastes time; more importantly it signals "don't touch").
async function minifyTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await minifyTree(full);
      continue;
    }
    if (entry.name.endsWith(".min.js")) continue;
    const ext = extname(entry.name);
    const loader = ext === ".js" ? "js" : ext === ".css" ? "css" : null;
    if (!loader) continue;
    const source = await readFile(full, "utf-8");
    const result = await transform(source, { minify: true, loader, target: "chrome120" });
    await writeFile(full, result.code, "utf-8");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
