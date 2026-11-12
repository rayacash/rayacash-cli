// @ts-check
// El paquete como lo recibe quien lo instala, sin red:
//
// 1. `npm pack`: la lista exacta de archivos (CHANGELOG.md, LICENSE, README.md, package.json y un
//    dist/*.js por cada src/*.ts).
// 2. Lo instala desde el .tgz en una carpeta temporal (`npm install -g --prefix … --offline`: no
//    tiene dependencias).
// 3. Corre los dos bins: `rayacash --version` y `rayacash-cli --help`; en POSIX, además, el bit +x.
//    En Windows, por los .cmd que crea npm.
//
// Usa el dist que haya (está commiteado; `npm run check:package` lo vuelve a compilar antes).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WINDOWS = process.platform === "win32";
const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** @param {string} message */
function fail(message) {
  console.error(`check-package: ${message}`);
  process.exit(1);
}

/**
 * En Windows, npm y los bins son .cmd: van por la shell, con las rutas entre comillas.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env) {
  const quote = (/** @type {string} */ value) =>
    WINDOWS && /\s/.test(value) ? `"${value}"` : value;
  const result = spawnSync(quote(command), args.map(quote), {
    cwd: ROOT,
    encoding: "utf8",
    shell: WINDOWS,
    env: { ...process.env, npm_config_update_notifier: "false", ...env },
  });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} salió con ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

if (!existsSync(path.join(ROOT, "dist", "cli.js"))) fail("falta dist: corré npm run compile.");

const sources = readdirSync(path.join(ROOT, "src")).filter((name) => name.endsWith(".ts"));
const expected = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  ...sources.map((name) => `dist/${name.replace(/\.ts$/, ".js")}`),
].sort();

const tmp = mkdtempSync(path.join(os.tmpdir(), "rayacash-cli-pack-"));
try {
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp]),
  );
  const files = packed[0].files.map((/** @type {{path: string}} */ file) => file.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    fail(
      `el paquete trae otros archivos:\n  ${files.join("\n  ")}\nesperados:\n  ${expected.join("\n  ")}`,
    );
  }
  const tarball = path.join(tmp, packed[0].filename);
  const prefix = path.join(tmp, "prefix");
  run("npm", [
    "install",
    "-g",
    "--prefix",
    prefix,
    tarball,
    "--offline",
    "--no-audit",
    "--no-fund",
  ]);

  const bin = (/** @type {string} */ name) =>
    WINDOWS ? path.join(prefix, `${name}.cmd`) : path.join(prefix, "bin", name);
  // Una configuración temporal: --version y --help no la tocan, pero por las dudas.
  const env = { XDG_CONFIG_HOME: tmp, APPDATA: tmp, RAYA_SECRET_KEY: "", RAYA_API_BASE: "" };
  const shown = run(bin("rayacash"), ["--version"], env).trim();
  if (shown !== `rayacash-cli ${version}`) fail(`rayacash --version dio «${shown}».`);
  const help = run(bin("rayacash-cli"), ["--help"], env);
  if (!help.includes("Uso:")) fail("rayacash-cli --help no muestra la ayuda.");
  if (!WINDOWS) {
    const installed = path.join(prefix, "lib", "node_modules", "rayacash-cli", "dist", "cli.js");
    if ((statSync(installed).mode & 0o111) === 0)
      fail("dist/cli.js quedó sin permiso de ejecución.");
  }
  console.log(`Paquete OK: ${packed[0].filename}, ${files.length} archivos, los dos bins andan.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
