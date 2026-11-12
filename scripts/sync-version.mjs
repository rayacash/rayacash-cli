// @ts-check
// La versión vive en un solo lugar, package.json, y este script la copia a src/version.ts (la usan
// --version y el User-Agent). Corre solo con `npm version`; con --check falla si no coinciden
// (build y CI).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION_FILE = path.join(ROOT, "src", "version.ts");
const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const expected =
  "// Generado por scripts/sync-version.mjs desde package.json: no lo edites a mano.\n" +
  `export const VERSION = "${version}";\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(VERSION_FILE, "utf8") !== expected) {
    console.error(
      `src/version.ts no tiene la versión ${version} de package.json: corré node scripts/sync-version.mjs.`,
    );
    process.exit(1);
  }
} else {
  writeFileSync(VERSION_FILE, expected);
  console.log(`src/version.ts → ${version}`);
}
