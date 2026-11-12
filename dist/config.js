// La configuración: {"api_key": "raya_sk_test_…", "webhook_secret": "whsec_…"} en un archivo que
// solo tu usuario puede leer. Las claves que no conocemos se conservan al reescribir.
//
// - Linux y macOS: $XDG_CONFIG_HOME/rayacash/config.json (si es absoluta) o
//   ~/.config/rayacash/config.json. Windows: %APPDATA%\rayacash\config.json.
// - Se escribe a un temporal con modo 600 y se renombra encima: atómico, y queda en 600 aunque el
//   archivo existiera con 644. La carpeta, 700. En Windows lo privado lo dan las ACL del perfil.
// - Toda reescritura va adentro de un lock (config.json.lock, creado con flag wx): dos `rayacash`
//   que arrancan a la vez sobre una configuración vacía terminan con el mismo secreto.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import path from "node:path";
import { CliError } from "./args.js";
import { MSG } from "./messages.js";
/** Un problema con el archivo de configuración: exit 1. */
export class ConfigError extends CliError {
    constructor(message) {
        super(message, 1);
        this.name = "ConfigError";
    }
}
export const LOCK_TIMING = { staleMs: 10_000, retryMs: 25, timeoutMs: 15_000 };
const SECRET_RE = /^whsec_[A-Za-z0-9_-]{8,256}$/;
export function configPath(env, platform, home) {
    if (platform === "win32") {
        const base = env.APPDATA || path.win32.join(home, "AppData", "Roaming");
        return path.win32.join(base, "rayacash", "config.json");
    }
    const xdg = env.XDG_CONFIG_HOME;
    const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".config");
    return path.posix.join(base, "rayacash", "config.json");
}
/** La configuración guardada, o {} si todavía no hay archivo. */
export function readConfig(file, cmd = "rayacash") {
    let text;
    try {
        text = readFileSync(file, "utf8");
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return {};
        throw new ConfigError(MSG.configRead(file, errorDetail(error)));
    }
    let parsed;
    try {
        // Un editor de Windows puede dejar un BOM adelante.
        parsed = JSON.parse(text.replace(/^﻿/, ""));
    }
    catch {
        throw new ConfigError(MSG.configBroken(file, cmd));
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ConfigError(MSG.configBroken(file, cmd));
    }
    return parsed;
}
/** Escribe la configuración entera (atómico, 600). Mejor por updateConfig, que toma el lock. */
export function writeConfig(file, config) {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        makeFolder(file);
        const data = `${JSON.stringify(config, null, 2)}\n`;
        try {
            writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
        }
        catch (error) {
            // Un temporal de un proceso anterior con el mismo pid: es nuestro, se pisa.
            if (errorCode(error) !== "EEXIST")
                throw error;
            unlinkSync(temporary);
            writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
        }
        rename(temporary, file);
    }
    catch (error) {
        removeQuietly(temporary);
        throw new ConfigError(MSG.configWrite(file, errorDetail(error)));
    }
}
/** Lee, cambia y guarda, con el lock tomado. Devuelve lo que devuelve `change`. */
export function updateConfig(file, cmd, change, timing = LOCK_TIMING) {
    return withLock(file, () => {
        const config = readConfig(file, cmd);
        const result = change(config);
        writeConfig(file, config);
        return result;
    }, timing);
}
/**
 * El secreto de firma de esta máquina (whsec_ + 43 caracteres), creado la primera vez que hace
 * falta. Adentro del lock se relee: si otro proceso lo acaba de crear, se usa ese.
 */
export function ensureSecret(file, cmd = "rayacash", timing = LOCK_TIMING) {
    const current = readConfig(file, cmd).webhook_secret;
    if (isSecret(current))
        return current;
    return withLock(file, () => {
        const config = readConfig(file, cmd);
        if (isSecret(config.webhook_secret))
            return config.webhook_secret;
        config.webhook_secret = newSecret();
        writeConfig(file, config);
        // Lo que quedó en disco.
        return String(readConfig(file, cmd).webhook_secret);
    }, timing);
}
/** El formato de los secretos de los destinos: whsec_ + secrets.token_urlsafe(32). */
export function newSecret() {
    return `whsec_${randomBytes(32).toString("base64url")}`;
}
function isSecret(value) {
    return typeof value === "string" && SECRET_RE.test(value);
}
/** El aviso si el archivo tiene permisos de grupo u otros (POSIX), o null. */
export function permissionWarning(file, platform) {
    if (platform === "win32")
        return null;
    let mode;
    try {
        mode = statSync(file).mode;
    }
    catch {
        return null;
    }
    return mode & 0o077 ? MSG.configInsecure(file) : null;
}
function withLock(file, body, timing) {
    const lock = `${file}.lock`;
    try {
        makeFolder(file);
    }
    catch (error) {
        throw new ConfigError(MSG.configWrite(file, errorDetail(error)));
    }
    const deadline = Date.now() + timing.timeoutMs;
    for (;;) {
        try {
            writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
            break;
        }
        catch (error) {
            if (errorCode(error) !== "EEXIST") {
                throw new ConfigError(MSG.configWrite(file, errorDetail(error)));
            }
        }
        if (lockAge(lock) > timing.staleMs) {
            removeQuietly(lock);
            continue;
        }
        if (Date.now() > deadline)
            throw new ConfigError(MSG.configWrite(file, MSG.configBusy));
        sleepSync(timing.retryMs);
    }
    try {
        return body();
    }
    finally {
        removeQuietly(lock);
    }
}
function makeFolder(file) {
    const folder = path.dirname(file);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Solo la carpeta propia (…/rayacash): nunca se tocan los permisos de otra.
    if (process.platform !== "win32" && path.basename(folder) === "rayacash") {
        try {
            chmodSync(folder, 0o700);
        }
        catch {
            // No es nuestra (por ejemplo, la creó otro usuario): el aviso de permisos lo dice.
        }
    }
}
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
/** En Windows, renombrar encima falla mientras otro proceso lee el archivo: se reintenta. */
function rename(from, to) {
    for (let attempt = 1;; attempt += 1) {
        try {
            renameSync(from, to);
            return;
        }
        catch (error) {
            if (process.platform !== "win32" || attempt >= 20 || !BUSY.has(errorCode(error) ?? "")) {
                throw error;
            }
            sleepSync(25);
        }
    }
}
function lockAge(lock) {
    try {
        return Date.now() - statSync(lock).mtimeMs;
    }
    catch {
        // Se liberó entre el intento y el stat: se reintenta enseguida.
        return Number.POSITIVE_INFINITY;
    }
}
function removeQuietly(file) {
    try {
        unlinkSync(file);
    }
    catch {
        // Ya no está.
    }
}
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
    Atomics.wait(SLEEPER, 0, 0, ms);
}
function errorCode(error) {
    const code = error?.code;
    return typeof code === "string" ? code : undefined;
}
export function errorDetail(error) {
    return errorCode(error) ?? (error instanceof Error ? error.message : String(error));
}
