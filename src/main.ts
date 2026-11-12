// El despacho de los comandos: login, logout, listen, la ayuda y la versión. main() recibe todo lo
// de afuera en `io` (los tests lo reemplazan) y devuelve el código de salida; run() lo arma con el
// proceso real y lo usa cli.ts.

import { existsSync } from "node:fs";
import os from "node:os";
import { pollEvents } from "./api.ts";
import { resolveApiBase } from "./apiBase.ts";
import { CliError, type ListenCommand, parseCommandLine } from "./args.ts";
import {
  configPath,
  ensureSecret,
  errorDetail,
  permissionWarning,
  readConfig,
  updateConfig,
} from "./config.ts";
import { parseEventArgs } from "./events.ts";
import { forward, normalizeForwardUrl } from "./forward.ts";
import { checkKey, classifyKey, maskKey, resolveKey } from "./keys.ts";
import { type ListenDeps, runListen, sleep } from "./listen.ts";
import { cmdName, type Env, MSG, npmLogsDir } from "./messages.ts";
import type { Out } from "./output.ts";
import { type Input, readHidden, readLine } from "./prompt.ts";

export interface Io {
  env: Env;
  platform: NodeJS.Platform;
  homedir: () => string;
  /** process.versions.node */
  nodeVersion: string;
  stdout: Out;
  stderr: Out;
  stdin: Input;
  exists: (path: string) => boolean;
  /** Registra algo para cuando sale el proceso (restaurar la terminal); devuelve cómo sacarlo. */
  onExit: (run: () => void) => () => void;
  listen: Omit<ListenDeps, "stdout" | "stderr" | "env">;
}

const say = (out: Out, text: string) => out.write(`${text}\n`);

/** Cuánto espera el proceso después de un Ctrl+C antes de salir (la copia de npm). */
const SIGNAL_GRACE_MS = 200;

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const cmd = cmdName(io.env);
  try {
    if (Number.parseInt(io.nodeVersion, 10) < 22) {
      say(io.stderr, MSG.nodeTooOld(io.nodeVersion));
      return 1;
    }
    const command = parseCommandLine(argv, { cmd, exists: io.exists });
    switch (command.kind) {
      case "help":
        io.stdout.write(command.text);
        return 0;
      case "version":
        say(io.stdout, MSG.version);
        return 0;
      case "login":
        return await login(command.apiKey, io, cmd);
      case "logout":
        return logout(io, cmd);
      case "listen":
        return await listen(command, io, cmd);
    }
  } catch (error) {
    if (error instanceof CliError) {
      say(io.stderr, error.message);
      return error.exitCode;
    }
    say(io.stderr, MSG.unexpected(errorDetail(error)));
    return 1;
  }
}

function pathOf(io: Io): string {
  return configPath(io.env, io.platform, io.homedir());
}

async function login(apiKey: string | undefined, io: Io, cmd: string): Promise<number> {
  const file = pathOf(io);
  let raw: string;
  if (apiKey !== undefined) {
    raw = apiKey;
  } else if (io.stdin.isTTY) {
    say(io.stderr, MSG.loginPrompt);
    const typed = await readHidden({
      input: io.stdin,
      output: io.stderr,
      prompt: MSG.loginLabel,
      onExit: io.onExit,
    });
    if (typed === null) {
      say(io.stderr, MSG.cancelled);
      return 130;
    }
    raw = typed;
  } else {
    // Git Bash o mintty sin TTY: lo que pegás se ve, y hay que apretar Enter.
    if (io.env.MSYSTEM) {
      say(io.stderr, MSG.loginVisible(cmd));
      say(io.stderr, MSG.loginPressEnter);
    }
    raw = await readLine(io.stdin);
  }
  // Con npx y --api-key, npm ya anotó el comando (con la clave) en sus logs.
  const npmLogs = apiKey !== undefined ? npmLogsDir(io.env, io.platform) : null;
  const key = checkKey(raw, "input", npmLogs);
  const previous = updateConfig(file, cmd, (config) => {
    const before = config.api_key;
    config.api_key = key;
    return before;
  });
  const mask = maskKey(key);
  say(
    io.stdout,
    typeof previous === "string" && previous !== key
      ? MSG.loginReplaced(mask, file, maskKey(previous))
      : MSG.loginSaved(mask, file),
  );
  if (npmLogs) say(io.stderr, MSG.apiKeyNpmLogged(npmLogs, cmd));
  // RAYA_SECRET_KEY le gana a la guardada (salvo una de la cuenta real, que listen ignora).
  const fromEnv = io.env.RAYA_SECRET_KEY?.trim();
  if (fromEnv && fromEnv !== key && classifyKey(fromEnv) !== "live_secret") {
    say(io.stderr, MSG.envKeyWins(maskKey(fromEnv), cmd));
  }
  return 0;
}

function logout(io: Io, cmd: string): number {
  const file = pathOf(io);
  const saved = readConfig(file, cmd).api_key;
  if (saved === undefined) {
    say(io.stdout, MSG.logoutNothing);
    return 0;
  }
  updateConfig(file, cmd, (config) => {
    delete config.api_key;
  });
  say(io.stdout, MSG.logoutDone(maskKey(String(saved))));
  return 0;
}

async function listen(command: ListenCommand, io: Io, cmd: string): Promise<number> {
  const file = pathOf(io);
  const warnPermissions = () => {
    const warning = permissionWarning(file, io.platform);
    if (warning) say(io.stderr, warning);
  };
  if (command.printSecret) {
    // stdout lleva solo el secreto: export RAYA_WEBHOOK_SECRET="$(rayacash listen --print-secret)".
    const secret = ensureSecret(file, cmd);
    warnPermissions();
    say(io.stdout, secret);
    return 0;
  }
  const api = resolveApiBase(io.env);
  if (api.custom) say(io.stderr, MSG.apiBaseUsing(api.base));
  const config = readConfig(file, cmd);
  warnPermissions();
  const npmLogs = npmLogsDir(io.env, io.platform);
  const { key, source } = resolveKey({
    flag: command.apiKey,
    env: io.env,
    saved: config.api_key,
    cmd,
    warn: (message) => say(io.stderr, message),
    npmLogs,
  });
  if (source === "flag") {
    say(io.stderr, MSG.apiKeyVisible(cmd));
    if (npmLogs) say(io.stderr, MSG.apiKeyNpmLogged(npmLogs, cmd));
  }
  const forwardTo = command.forwardTo === undefined ? null : normalizeForwardUrl(command.forwardTo);
  const events = command.events.length > 0 ? parseEventArgs(command.events) : ["*"];
  const secret = ensureSecret(file, cmd);
  if (io.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    // La clave viaja a la API: su certificado se verifica siempre. Node lee la variable en cada
    // conexión, así que sin ella el fetch verifica; el reenvío a tu servidor decide aparte
    // (--skip-verify, solo para ese request).
    delete io.env.NODE_TLS_REJECT_UNAUTHORIZED;
    say(io.stderr, MSG.tlsRejectIgnored);
  }
  return runListen(
    {
      apiBase: api.base,
      apiKey: key,
      keySource: source,
      events,
      forwardTo,
      secret,
      json: command.json,
      skipVerify: command.skipVerify,
      cmd,
    },
    { ...io.listen, stdout: io.stdout, stderr: io.stderr, env: io.env },
  );
}

/** Lo que usa cli.ts: main() con el proceso real. */
export async function run(): Promise<void> {
  const handlers = new Set<() => void>();
  let pipeClosed = false;
  // Si listen terminó por Ctrl+C (o SIGTERM): el proceso sale distinto (abajo).
  let signalled = false;
  // `rayacash listen --json | head -n 1`: al cerrarse la salida, se corta en orden y sale con 0
  // (sin esto, Node muere con la traza de EPIPE).
  const onStreamError = () => {
    if (pipeClosed) return;
    pipeClosed = true;
    for (const handler of handlers) handler();
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
  const signals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const io: Io = {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir,
    nodeVersion: process.versions.node,
    stdout: process.stdout,
    stderr: process.stderr,
    // process.stdin se crea al tocarlo: solo login lo usa.
    get stdin() {
      return process.stdin;
    },
    exists: existsSync,
    onExit: (restore) => {
      process.once("exit", restore);
      return () => process.removeListener("exit", restore);
    },
    listen: {
      api: pollEvents,
      forward,
      sleep,
      now: Date.now,
      clock: () => new Date(),
      random: Math.random,
      onSignal: (handler) => {
        const onProcessSignal = () => {
          signalled = true;
          handler();
        };
        for (const signal of signals) process.on(signal, onProcessSignal);
        handlers.add(handler);
        return () => {
          for (const signal of signals) process.removeListener(signal, onProcessSignal);
          handlers.delete(handler);
        };
      },
    },
  };
  const code = await main(process.argv.slice(2), io);
  const exitCode = pipeClosed ? 0 : code;
  process.exitCode = exitCode;
  if (signalled) {
    // Ctrl+C: npm (npx, npm exec) le reenvía su copia unos ms después. El handler sigue puesto
    // (runListen no lo saca) y el proceso espera un momento antes de salir: así la absorbe. Si
    // saliera enseguida, la copia podría caer mientras Node desarma el proceso, ya sin handler, y
    // lo mataría la señal (el shell vería 130 en vez de 0).
    setTimeout(() => process.exit(exitCode), SIGNAL_GRACE_MS);
    return;
  }
  // Por si queda un socket abierto (el pool de fetch): el proceso sale igual en medio segundo.
  setTimeout(() => process.exit(exitCode), 500).unref();
}
