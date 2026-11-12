// @ts-check
// Build sin bundler: tsc compila src/*.ts a dist/*.js (ESM). Corre con `npm run compile`,
// `npm run check:package` y `npm version`. dist se commitea (ver .gitignore): por eso el script no
// se llama build ni prepare, que harían que npm prepare el repo al instalarlo desde GitHub.
// tsc corre con este mismo node sobre typescript/lib/tsc.js y nunca por el .cmd de
// node_modules/.bin: en Windows, execFileSync no lanza un .cmd sin shell.
//
// Escribe solo en stderr: `npm pack --json` usa stdout.

import { execFileSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TSC = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
// La salida de tsc (y de sync-version) va a stderr, el fd 2.
/** @type {import("node:child_process").StdioOptions} */
const stdio = ["ignore", 2, 2];

execFileSync(process.execPath, [path.join(ROOT, "scripts", "sync-version.mjs"), "--check"], {
  stdio,
});
rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [TSC, "-p", path.join(ROOT, "tsconfig.build.json")], {
  cwd: ROOT,
  stdio,
});
try {
  // npm le pone +x al instalar; esto es para correr dist/cli.js directo desde el repo.
  chmodSync(path.join(ROOT, "dist", "cli.js"), 0o755);
} catch {
  // Un sistema de archivos sin permisos POSIX: no hace falta.
}
console.error("dist listo.");
