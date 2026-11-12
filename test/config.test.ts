import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  ConfigError,
  configPath,
  ensureSecret,
  LOCK_TIMING,
  newSecret,
  permissionWarning,
  readConfig,
  updateConfig,
  writeConfig,
} from "../src/config.ts";
import { MSG } from "../src/messages.ts";
import { tempDir, testKey } from "./helpers.ts";

const posix = process.platform !== "win32";
const mode = (file: string) => statSync(file).mode & 0o777;

function configError(run: () => unknown, message: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.exitCode, 1);
    assert.equal(error.message, message);
    return true;
  });
}

describe("configPath", () => {
  test("Linux y macOS: XDG_CONFIG_HOME si es absoluta; si no, ~/.config", () => {
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/ana"),
      "/xdg/rayacash/config.json",
    );
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "relativa/xdg" }, "darwin", "/home/beto"),
      "/home/beto/.config/rayacash/config.json",
    );
    assert.equal(configPath({}, "linux", "/home/ana"), "/home/ana/.config/rayacash/config.json");
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "" }, "linux", "/home/ana"),
      "/home/ana/.config/rayacash/config.json",
    );
  });

  test("Windows: %APPDATA%, o AppData\\Roaming del perfil", () => {
    assert.equal(
      configPath({ APPDATA: "C:\\Users\\ana\\AppData\\Roaming" }, "win32", "C:\\Users\\ana"),
      "C:\\Users\\ana\\AppData\\Roaming\\rayacash\\config.json",
    );
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "/xdg" }, "win32", "C:\\Users\\ana"),
      "C:\\Users\\ana\\AppData\\Roaming\\rayacash\\config.json",
    );
  });
});

describe("leer y escribir", () => {
  test("sin archivo: {}", () => {
    assert.deepEqual(readConfig(path.join(tempDir(), "no", "config.json")), {});
  });

  test("un archivo nuevo queda en 600 y la carpeta en 700", { skip: !posix }, () => {
    const file = path.join(tempDir(), "xdg", "rayacash", "config.json");
    writeConfig(file, { api_key: testKey() });
    assert.equal(mode(file), 0o600);
    assert.equal(mode(path.dirname(file)), 0o700);
    assert.deepEqual(readConfig(file), { api_key: testKey() });
    assert.equal(readFileSync(file, "utf8").endsWith("}\n"), true);
  });

  test("uno que existía con 644 queda en 600, y la carpeta en 700", { skip: !posix }, () => {
    const dir = path.join(tempDir(), "rayacash");
    mkdirSync(dir, { mode: 0o755 });
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    assert.match(permissionWarning(file, process.platform) ?? "", /^Ojo: /);
    writeConfig(file, { webhook_secret: newSecret() });
    assert.equal(mode(file), 0o600);
    assert.equal(mode(dir), 0o700);
    assert.equal(permissionWarning(file, process.platform), null);
  });

  test("la escritura es atómica: no deja temporales y pisa uno viejo del mismo pid", () => {
    const dir = path.join(tempDir(), "rayacash");
    mkdirSync(dir);
    const file = path.join(dir, "config.json");
    writeFileSync(`${file}.${process.pid}.tmp`, "basura");
    writeConfig(file, { a: 1 });
    writeConfig(file, { a: 2 });
    assert.deepEqual(readdirSync(dir), ["config.json"]);
    assert.deepEqual(readConfig(file), { a: 2 });
  });

  test("updateConfig conserva las claves que no conoce", () => {
    const file = path.join(tempDir(), "rayacash", "config.json");
    writeConfig(file, { api_key: testKey(), webhook_secret: "whsec_abcdefgh", tema: { x: 1 } });
    const before = updateConfig(file, "rayacash", (config) => {
      const key = config.api_key;
      delete config.api_key;
      return key;
    });
    assert.equal(before, testKey());
    assert.deepEqual(readConfig(file), { webhook_secret: "whsec_abcdefgh", tema: { x: 1 } });
    assert.equal(existsSync(`${file}.lock`), false);
  });

  test("JSON roto, un array o un BOM", () => {
    const file = path.join(tempDir(), "config.json");
    for (const text of ["{roto", "[1]", '"texto"', "null"]) {
      writeFileSync(file, text);
      configError(
        () => readConfig(file, "npx rayacash-cli"),
        MSG.configBroken(file, "npx rayacash-cli"),
      );
    }
    assert.equal(
      MSG.configBroken("/x/config.json", "rayacash"),
      "El archivo de configuración /x/config.json no es JSON válido. Borralo y volvé a correr rayacash login.",
    );
    writeFileSync(file, '\uFEFF{"api_key":"x"}');
    assert.deepEqual(readConfig(file), { api_key: "x" });
  });

  test("no se puede leer: una carpeta en lugar del archivo", () => {
    const file = path.join(tempDir(), "config.json");
    mkdirSync(file);
    configError(() => readConfig(file), MSG.configRead(file, "EISDIR"));
  });

  test("no se puede escribir: el texto con el detalle", () => {
    const base = tempDir();
    const blocker = path.join(base, "archivo");
    writeFileSync(blocker, "");
    // La carpeta de la configuración tendría que estar adentro de un archivo.
    const file = path.join(blocker, "rayacash", "config.json");
    assert.throws(
      () => writeConfig(file, {}),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.startsWith(`No pudimos guardar la configuración en ${file}: `),
    );
    assert.throws(
      () => updateConfig(file, "rayacash", () => 1),
      (error: unknown) => error instanceof ConfigError && error.exitCode === 1,
    );
    assert.equal(
      MSG.configWrite("/x/config.json", "EACCES"),
      "No pudimos guardar la configuración en /x/config.json: EACCES.",
    );
  });

  test("el aviso de permisos (POSIX) y nunca en Windows", { skip: !posix }, () => {
    const file = path.join(tempDir(), "config.json");
    writeFileSync(file, "{}", { mode: 0o640 });
    chmodSync(file, 0o640);
    assert.equal(
      permissionWarning(file, "linux"),
      `Ojo: ${file} lo pueden leer otros usuarios de esta máquina. Corré chmod 600 "${file}".`,
    );
    assert.equal(permissionWarning(file, "win32"), null);
    assert.equal(permissionWarning(path.join(tempDir(), "no-existe"), "linux"), null);
  });
});

describe("el secreto de firma", () => {
  test("whsec_ + 43 caracteres urlsafe, estable entre llamadas", () => {
    const file = path.join(tempDir(), "rayacash", "config.json");
    const secret = ensureSecret(file);
    assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.equal(ensureSecret(file), secret);
    assert.deepEqual(readConfig(file), { webhook_secret: secret });
    assert.notEqual(newSecret(), newSecret());
  });

  test("conserva la clave guardada y reemplaza un secreto con otra forma", () => {
    const file = path.join(tempDir(), "rayacash", "config.json");
    writeConfig(file, { api_key: testKey(), webhook_secret: "no-es-un-secreto" });
    const secret = ensureSecret(file);
    assert.match(secret, /^whsec_/);
    assert.deepEqual(readConfig(file), { api_key: testKey(), webhook_secret: secret });
  });

  test("un lock viejo (de un proceso que murió) se borra", () => {
    const file = path.join(tempDir(), "rayacash", "config.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, "999999\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    assert.match(ensureSecret(file), /^whsec_/);
    assert.equal(existsSync(`${file}.lock`), false);
  });

  test("con un lock vigente de otro proceso, espera y se rinde con un error claro", () => {
    const file = path.join(tempDir(), "rayacash", "config.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, "999999\n");
    configError(
      () => ensureSecret(file, "rayacash", { staleMs: 60_000, retryMs: 5, timeoutMs: 30 }),
      MSG.configWrite(file, "otro proceso de rayacash-cli la está usando"),
    );
    assert.equal(existsSync(`${file}.lock`), true);
    assert.deepEqual(LOCK_TIMING, { staleMs: 10_000, retryMs: 25, timeoutMs: 15_000 });
  });

  test("un lock que queda viejo mientras espera se borra y se toma", () => {
    const file = path.join(tempDir(), "rayacash", "config.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, "999999\n");
    const secret = ensureSecret(file, "rayacash", { staleMs: 40, retryMs: 10, timeoutMs: 5_000 });
    assert.match(secret, /^whsec_/);
    assert.equal(existsSync(`${file}.lock`), false);
  });

  test("no puede crear el lock: el error con su código", { skip: !posix }, () => {
    // 251 caracteres: el archivo entra en el límite de 255, «.lock» ya no.
    const file = path.join(tempDir(), "c".repeat(251));
    configError(() => ensureSecret(file), MSG.configWrite(file, "ENAMETOOLONG"));
  });

  test("no puede crear la carpeta", { skip: !posix || process.getuid?.() === 0 }, () => {
    const base = path.join(tempDir(), "solo-lectura");
    mkdirSync(base, { mode: 0o500 });
    chmodSync(base, 0o500);
    const file = path.join(base, "rayacash", "config.json");
    try {
      configError(() => ensureSecret(file), MSG.configWrite(file, "EACCES"));
    } finally {
      chmodSync(base, 0o700);
    }
  });

  test("una carpeta que no se puede leer", { skip: !posix }, () => {
    const blocker = path.join(tempDir(), "archivo");
    writeFileSync(blocker, "");
    const file = path.join(blocker, "rayacash", "config.json");
    configError(() => ensureSecret(file), MSG.configRead(file, "ENOTDIR"));
  });
});
