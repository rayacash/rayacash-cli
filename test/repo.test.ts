// Lo que nunca puede entrar al repo (que es público): claves, nombres de otras empresas, nombres
// prohibidos por las reglas de la casa ni rutas, hosts o puertos internos. Los patrones se arman
// de forma que este archivo no coincida consigo mismo.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { ROOT, tempDir } from "./helpers.ts";

const TRACKED_DIRS = ["src", "dist", "test", "scripts", ".github"];
const TRACKED_FILES = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "package.json",
  "biome.json",
  "tsconfig.json",
  "tsconfig.build.json",
  ".gitignore",
  ".gitattributes",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = [
  ...TRACKED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))),
  ...TRACKED_FILES.map((name) => path.join(ROOT, name)),
];

function offenders(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(readFileSync(file, "utf8")));
}

describe("el repo", () => {
  test("ninguna clave literal", () => {
    assert.deepEqual(offenders(/raya_(sk|pk|at|cs)_(live|test)_[0-9A-Za-z]{48}/), []);
  });

  test("ningún secreto de firma con forma real (los escáneres de secretos de GitHub lo frenarían)", () => {
    // whsec_ + 32 o más alfanuméricos seguidos es la forma de los secretos de webhooks de otros
    // proveedores. Los tests los arman en código (helpers.whsec) y el README usa uno que se ve falso.
    assert.deepEqual(offenders(/whsec_[A-Za-z0-9]{32,}/), []);
  });

  test("no nombra a otras empresas de pagos", () => {
    assert.deepEqual(offenders(/str[i]pe/i), []);
  });

  test("los nombres que las reglas del sandbox prohíben", () => {
    const forbidden = [
      /test[M]ode/,
      /test[m]ode/,
      /test [m]ode/i,
      /cuenta de [p]rueba/i,
      /modo de [p]rueba/i,
      /modo [t]est/i,
      /test_[t]itle/,
      /test_[t]ext/,
      /\.test === [t]rue/,
    ];
    for (const pattern of forbidden) assert.deepEqual(offenders(pattern), [], String(pattern));
  });

  test("nada interno: rutas, hosts, carpetas de trabajo ni puertos", () => {
    const internal = [
      /sta[g]ing/i,
      /\/U[s]ers\//,
      /\/priv[a]te\/tmp/,
      /cla[u]de-/i,
      /scratch[p]ad/i,
      /raya-a[p]i/i,
      /\b(?:81[2]3|30[0]7|54[3]2|63[7]9)\b/,
    ];
    for (const pattern of internal) assert.deepEqual(offenders(pattern), [], String(pattern));
  });

  test("package.json: sin dependencias, versiones exactas y el bin compilado", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(pkg.dependencies, undefined);
    assert.deepEqual(pkg.bin, { rayacash: "dist/cli.js", "rayacash-cli": "dist/cli.js" });
    assert.deepEqual(pkg.files, ["dist", "CHANGELOG.md"]);
    assert.deepEqual(pkg.engines, { node: ">=22" });
    for (const version of Object.values(pkg.devDependencies as Record<string, string>)) {
      assert.match(version, /^\d+\.\d+\.\d+$/);
    }
    assert.match(String(pkg.description), /\(si tu cuenta lo tiene\)/);
  });

  test("package.json: ningún script que haga que npm prepare el repo al instalarlo desde GitHub", () => {
    // Con cualquiera de estos, `npm install -g github:…` corre un `npm install` del clon que
    // hereda el modo global: instala el clon en vez de sus devDependencies y queda roto.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) {
      assert.equal(pkg.scripts[name], undefined, name);
    }
    assert.equal(pkg.scripts.compile, "node scripts/build.mjs");
  });

  test("dist es exactamente lo que compila src (se commitea)", () => {
    const out = tempDir();
    const tsc = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
    const result = spawnSync(
      process.execPath,
      [tsc, "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", out],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const built = readdirSync(out).sort();
    assert.deepEqual(readdirSync(path.join(ROOT, "dist")).sort(), built);
    for (const name of built) {
      assert.equal(
        readFileSync(path.join(ROOT, "dist", name), "utf8"),
        readFileSync(path.join(out, name), "utf8"),
        `dist/${name} no está al día: corré npm run compile`,
      );
    }
  });
});
