// @ts-check
// Corre los tests con node:test sobre el TypeScript sin compilar (type stripping).
//
//   node scripts/test.mjs                 todos los tests
//   node scripts/test.mjs --coverage      además, la cobertura de src/ con sus mínimos
//   node scripts/test.mjs test/x.test.ts  solo esos archivos
//
// test/guard.ts se precarga en cada proceso (también en los hijos que lanzan los tests): ningún
// test sale de la máquina ni toca tu configuración real.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUARD = pathToFileURL(path.join(ROOT, "test", "guard.ts")).href;
const argv = process.argv.slice(2);
const coverage = argv.includes("--coverage");
const chosen = argv.filter((arg) => !arg.startsWith("--"));
const files =
  chosen.length > 0
    ? chosen
    : readdirSync(path.join(ROOT, "test"))
        .filter((name) => name.endsWith(".test.ts"))
        .sort()
        .map((name) => path.join("test", name));

const args = [];
// Node 22.18+ y 23.6+ ya sacan los tipos solos; en 22.6–22.17 hace falta el flag.
if (!process.features.typescript) {
  args.push("--experimental-strip-types", "--disable-warning=ExperimentalWarning");
}
args.push("--import", GUARD, "--test", "--test-reporter=spec", "--test-reporter-destination=stdout");
// En GitHub Actions, además, una anotación por cada test que falla (scripts/gha-reporter.mjs).
if (process.env.GITHUB_ACTIONS === "true") {
  const reporter = pathToFileURL(path.join(ROOT, "scripts", "gha-reporter.mjs")).href;
  args.push(`--test-reporter=${reporter}`, "--test-reporter-destination=stdout");
}
if (coverage) {
  // cli.ts queda afuera: es el shebang, la guarda de versión y el import de main.ts (lo prueban
  // los hijos de cli.test.ts). El modo raw de una terminal real y SIGBREAK no se cubren en CI.
  args.push(
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-coverage-exclude=src/cli.ts",
    "--test-coverage-lines=95",
    "--test-coverage-functions=95",
    "--test-coverage-branches=90",
  );
}
args.push(...files);

const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
process.exit(result.status ?? 1);
