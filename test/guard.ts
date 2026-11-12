// Ningún test sale de la máquina ni toca tu configuración real.
//
// - Sockets: solo contra loopback y solo a los puertos que registran los servidores de prueba
//   (fake-api.ts y receiver.ts, con allowPort). Es una lista blanca: cualquier otro puerto de esta
//   máquina tampoco se toca. Los procesos hijos heredan los puertos por RAYACASH_TEST_PORTS.
// - Con RAYACASH_TEST_SOCKET_LOG, anota cada intento de conexión (permitido o no) en ese archivo:
//   así un test comprueba que un comando no abrió ningún socket.
// - En el proceso de tests: HOME, XDG_CONFIG_HOME y APPDATA en una carpeta temporal, y sin
//   RAYA_SECRET_KEY, RAYA_API_BASE ni lo que cambia la salida (colores, proxies, MSYSTEM). Un hijo
//   (RAYACASH_TEST_CHILD=1) recibe su entorno armado por helpers.ts y no lo cambia.
//
// Se precarga en cada proceso de test (scripts/test.mjs) y en cada hijo (helpers.ts).

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PORTS_ENV = "RAYACASH_TEST_PORTS";
export const SOCKET_LOG_ENV = "RAYACASH_TEST_SOCKET_LOG";
export const CHILD_ENV = "RAYACASH_TEST_CHILD";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const REGISTRY = Symbol.for("rayacash-cli.test.ports");
const store = globalThis as unknown as Record<symbol, Set<number> | undefined>;
const ports = store[REGISTRY] ?? new Set<number>();
store[REGISTRY] = ports;
for (const value of (process.env[PORTS_ENV] ?? "").split(",")) {
  const port = Number(value);
  if (Number.isInteger(port) && port > 0) ports.add(port);
}

/** Deja conectar a 127.0.0.1:<port> (lo llaman los servidores de prueba al escuchar). */
export function allowPort(port: number): void {
  ports.add(port);
}

export function allowedPorts(): number[] {
  return [...ports];
}

if (process.env[CHILD_ENV] !== "1") {
  const home = mkdtempSync(path.join(os.tmpdir(), "rayacash-cli-test-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  for (const name of [
    "RAYA_SECRET_KEY",
    "RAYA_API_BASE",
    "NO_COLOR",
    "FORCE_COLOR",
    "MSYSTEM",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NODE_EXTRA_CA_CERTS",
    "npm_lifecycle_event",
  ]) {
    delete process.env[name];
  }
  // Los procesos de cada archivo de tests heredan este entorno y no vuelven a armarlo.
  process.env[CHILD_ENV] = "1";
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}

interface Target {
  host: string;
  port: number;
  path: string | undefined;
}

function targetOf(args: unknown[]): Target {
  // net llama a connect con sus argumentos ya normalizados ([options, cb]) o con los del usuario.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    return {
      host: typeof options.host === "string" ? options.host : "localhost",
      port: Number(options.port),
      path: typeof options.path === "string" ? options.path : undefined,
    };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) {
    return { host: "localhost", port: Number.NaN, path: first };
  }
  return {
    host: typeof args[1] === "string" ? args[1] : "localhost",
    port: Number(first),
    path: undefined,
  };
}

const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const target = targetOf(args);
  const where = target.path ?? `${target.host}:${target.port}`;
  const log = process.env[SOCKET_LOG_ENV];
  if (log) appendFileSync(log, `${where}\n`);
  if (target.path !== undefined || !LOOPBACK.has(target.host) || !ports.has(target.port)) {
    throw new Error(
      `Los tests de rayacash-cli no salen de la máquina (intentó conectar a ${where}).`,
    );
  }
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
