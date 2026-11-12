// Lo que comparten los tests: claves falsas armadas en código (nunca un literal), carpetas
// temporales, streams y stdin falsos, el `io` de main() con relojes y esperas falsos, y correr el
// CLI como proceso hijo (con la guarda precargada).

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Io } from "../src/main.ts";
import type { Env } from "../src/messages.ts";
import type { Out } from "../src/output.ts";
import type { Input } from "../src/prompt.ts";
import { allowedPorts, CHILD_ENV, PORTS_ENV } from "./guard.ts";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CLI = path.join(ROOT, "src", "cli.ts");
export const GUARD_URL = pathToFileURL(path.join(ROOT, "test", "guard.ts")).href;
// Los hijos corren el TypeScript como este proceso: con el flag si a este se lo pasaron (Node
// 22.6–22.17), sin él si Node ya saca los tipos solo. Siempre sin el aviso de «experimental»: los
// tests miran stderr entero.
export const STRIP_TYPES = [
  ...(process.execArgv.includes("--experimental-strip-types")
    ? ["--experimental-strip-types"]
    : []),
  "--disable-warning=ExperimentalWarning",
];

/** Una clave secreta de prueba falsa: raya_sk_test_ + 48 caracteres. */
export function testKey(fill = "a1B2"): string {
  return `raya_sk_test_${fill.repeat(48).slice(0, 48)}`;
}

/** Una clave de la cuenta real falsa: nunca sale de la máquina (el CLI la rechaza antes). */
export function liveKey(): string {
  return `raya_sk_live_${"b".repeat(48)}`;
}

/** Un secreto de firma falso, whsec_ + 43 caracteres, armado en código (nunca un literal). */
export function whsec(fill = "Xy7"): string {
  return `whsec_${fill.repeat(43).slice(0, 43)}`;
}

export function evtId(n: number): string {
  return `evt_${String(n).padStart(24, "0")}`;
}

/** Un evento de sandbox como los manda la API: el body es el JSON exacto, en string. */
export function sandboxEvent(
  n: number,
  type = "payment.succeeded",
  extra: Record<string, unknown> = {},
): { id: string; type: string; body: string } {
  const id = evtId(n);
  const body = JSON.stringify({
    id,
    object: "event",
    type,
    api_version: "2026-10-23",
    created_at: "2026-11-12T10:31:02Z",
    livemode: false,
    data: { object: { id: `pay_${n}`, description: "Pedido ñandú — ✓" } },
    ...extra,
  });
  return { id, type, body };
}

const temporaries: string[] = [];
process.on("exit", () => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** Una carpeta temporal que se borra al terminar el proceso. */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rayacash-cli-t-"));
  temporaries.push(dir);
  return dir;
}

/** Un stream de salida que guarda lo escrito. */
export class Sink implements Out {
  text = "";
  isTTY: boolean;

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }

  lines(): string[] {
    return this.text.split("\n").filter((line) => line !== "");
  }
}

/** Un stdin falso: `send` emite datos, `end` cierra. Con isTTY, registra el modo raw. */
export class FakeInput extends EventEmitter implements Input {
  isTTY: boolean;
  raw: boolean[] = [];
  paused = true;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): this {
    this.raw.push(mode);
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  send(chunk: string): void {
    this.emit("data", chunk);
  }

  end(): void {
    this.emit("end");
  }
}

export interface FakeIo {
  io: Io;
  stdout: Sink;
  stderr: Sink;
  stdin: FakeInput;
  dir: string;
  /** Los handlers de señales registrados (para dispararlos). */
  signals: Set<() => void>;
  exitHooks: Set<() => void>;
  sleeps: number[];
  clock: { now: number };
}

/**
 * El `io` de main() para un test: carpeta de configuración propia (XDG_CONFIG_HOME), env limpio
 * más `env`, reloj falso (cada sleep lo adelanta) y la API y el reenvío que el test pase.
 */
export function fakeIo(
  o: { env?: Env; platform?: NodeJS.Platform; stdinTTY?: boolean } & Partial<Io["listen"]> = {},
): FakeIo {
  const dir = tempDir();
  const stdout = new Sink();
  const stderr = new Sink();
  const stdin = new FakeInput(o.stdinTTY ?? false);
  const signals = new Set<() => void>();
  const exitHooks = new Set<() => void>();
  const sleeps: number[] = [];
  const clock = { now: Date.UTC(2026, 10, 12, 13, 31, 2) };
  const { env, platform, stdinTTY: _ignored, ...listen } = o;
  const io: Io = {
    env: { XDG_CONFIG_HOME: path.join(dir, "config"), ...env },
    platform: platform ?? process.platform,
    homedir: () => dir,
    nodeVersion: "22.12.0",
    stdout,
    stderr,
    stdin,
    exists: () => false,
    onExit: (run) => {
      exitHooks.add(run);
      return () => exitHooks.delete(run);
    },
    listen: {
      api: async () => {
        throw new Error("el test no definió la API");
      },
      forward: async () => ({ status: 200, durationMs: 1 }),
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        clock.now += ms;
        if (signal.aborted) return;
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => clock.now,
      clock: () => new Date(clock.now),
      random: () => 0.5,
      onSignal: (handler) => {
        signals.add(handler);
        return () => signals.delete(handler);
      },
      ...listen,
    },
  };
  return { io, stdout, stderr, stdin, dir, signals, exitHooks, sleeps, clock };
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** El entorno de un hijo: limpio, con su carpeta de configuración y los puertos permitidos. */
export function childEnv(dir: string, env: Env = {}): Env {
  const base: Env = {
    PATH: process.env.PATH,
    [CHILD_ENV]: "1",
    [PORTS_ENV]: allowedPorts().join(","),
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    APPDATA: path.join(dir, "appdata"),
  };
  // Windows necesita estas para arrancar node; la cobertura junta la de los hijos.
  for (const name of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "NODE_V8_COVERAGE"]) {
    if (process.env[name] !== undefined) base[name] = process.env[name];
  }
  return { ...base, ...env };
}

/** Lanza `node src/cli.ts <args>` con la guarda precargada. */
export function spawnCli(
  args: string[],
  o: { dir: string; env?: Env; script?: string; preload?: string[] },
): ChildProcess {
  const preload = (o.preload ?? []).flatMap((url) => ["--import", url]);
  return spawn(
    process.execPath,
    [...STRIP_TYPES, "--import", GUARD_URL, ...preload, o.script ?? CLI, ...args],
    { cwd: o.dir, env: childEnv(o.dir, o.env), stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** Corre el CLI hasta que termina, con `input` en stdin. */
export function runCli(
  args: string[],
  o: { dir?: string; env?: Env; input?: string; script?: string; preload?: string[] } = {},
): Promise<ChildResult> {
  const child = spawnCli(args, {
    dir: o.dir ?? tempDir(),
    env: o.env,
    script: o.script,
    preload: o.preload,
  });
  return collect(child, o.input);
}

export function collect(child: ChildProcess, input?: string): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin?.end(input ?? "");
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Espera a que `read()` cumpla `ready`, o falla a los `ms`. */
export async function waitFor(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`No pasó a tiempo: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
