// El CLI como proceso hijo (node + strip-types + la guarda), como lo corre quien lo instala.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { readConfig } from "../src/config.ts";
import { HELP, MSG } from "../src/messages.ts";
import { sign } from "../src/signature.ts";
import { page, startFakeApi } from "./fake-api.ts";
import { SOCKET_LOG_ENV } from "./guard.ts";
import {
  collect,
  liveKey,
  ROOT,
  runCli,
  sandboxEvent,
  spawnCli,
  tempDir,
  testKey,
  waitFor,
} from "./helpers.ts";
import { startReceiver, testCerts } from "./receiver.ts";

const posix = process.platform !== "win32";
// Donde childEnv pone la configuración: XDG_CONFIG_HOME, o APPDATA en Windows.
const configFile = (dir: string) =>
  path.join(dir, posix ? "config" : "appdata", "rayacash", "config.json");

function socketLog(dir: string): { env: Record<string, string>; attempts: () => string[] } {
  const file = path.join(dir, "sockets.log");
  return {
    env: { [SOCKET_LOG_ENV]: file },
    attempts: () =>
      existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [],
  };
}

describe("rayacash (proceso)", () => {
  test("--help, --version y {cmd} con npx", async () => {
    const help = await runCli(["--help"]);
    assert.deepEqual([help.code, help.stdout, help.stderr], [0, HELP.main("rayacash"), ""]);
    const version = await runCli(["-v"]);
    assert.deepEqual([version.code, version.stdout], [0, "rayacash-cli 1.0.0\n"]);
    const npx = await runCli(["login", "--help"], { env: { npm_lifecycle_event: "npx" } });
    assert.equal(npx.stdout, HELP.login("npx rayacash-cli"));
  });

  test("--print-secret: solo el secreto, el mismo en cada corrida, archivo 600 y sin red", async () => {
    const dir = tempDir();
    const log = socketLog(dir);
    const first = await runCli(["listen", "--print-secret"], { dir, env: log.env });
    const second = await runCli(["listen", "--print-secret"], { dir, env: log.env });
    assert.equal(first.code, 0);
    assert.match(first.stdout, /^whsec_[A-Za-z0-9_-]{43}\n$/);
    assert.equal(second.stdout, first.stdout);
    assert.equal(first.stderr, "");
    assert.deepEqual(log.attempts(), []);
    if (posix) assert.equal(statSync(configFile(dir)).mode & 0o777, 0o600);
  });

  test("dos a la vez sobre una configuración vacía: el mismo secreto", async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([
      runCli(["listen", "--print-secret"], { dir }),
      runCli(["listen", "--print-secret"], { dir }),
    ]);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    assert.equal(a.stdout, b.stdout);
    assert.equal(readConfig(configFile(dir)).webhook_secret, a.stdout.trim());
  });

  test("una clave real: exit 2 con el texto exacto y ningún socket", async () => {
    const dir = tempDir();
    const log = socketLog(dir);
    const result = await runCli(["listen", "--api-key", liveKey()], {
      dir,
      env: { ...log.env, RAYA_API_BASE: "http://127.0.0.1:9" },
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.endsWith(`${MSG.keyLive("La clave de --api-key")}\n`));
    assert.equal(result.stderr.includes(liveKey()), false);
    assert.deepEqual(log.attempts(), []);
  });

  test('login por un pipe (printf %s "$KEY" | rayacash login) y logout', async () => {
    const dir = tempDir();
    const key = testKey("Pp1");
    const login = await runCli(["login"], { dir, input: key });
    assert.equal(login.code, 0);
    assert.match(login.stdout, /^Listo: guardamos la clave raya_sk_test_…/);
    assert.deepEqual(readConfig(configFile(dir)), { api_key: key });
    if (posix) assert.equal(statSync(configFile(dir)).mode & 0o777, 0o600);
    const logout = await runCli(["logout"], { dir });
    assert.equal(logout.code, 0);
    assert.deepEqual(readConfig(configFile(dir)), {});
  });

  test("un Node viejo ve el mensaje en castellano (y no un error de link)", async () => {
    const dir = tempDir();
    const fake = path.join(dir, "node20.mjs");
    writeFileSync(
      fake,
      'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "20.11.1" } });\n',
    );
    const result = await runCli(["listen"], { dir, preload: [pathToFileURL(fake).href] });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "rayacash-cli necesita Node.js 22 o más nuevo (tenés 20.11.1).\n");
    assert.equal(MSG.nodeTooOld("20.11.1"), result.stderr.trim());
  });

  test("cli.ts no tiene imports estáticos (tampoco dist/cli.js, si está compilado)", () => {
    const sources = [path.join(ROOT, "src", "cli.ts"), path.join(ROOT, "dist", "cli.js")];
    for (const file of sources.filter((name) => existsSync(name))) {
      const text = readFileSync(file, "utf8");
      assert.ok(text.startsWith("#!/usr/bin/env node\n"), file);
      assert.doesNotMatch(text, /^\s*import\s[^(]/m, file);
      assert.doesNotMatch(text, /\bawait\s+import\b/, file);
      assert.match(text, /import\("\.\/main\.(ts|js)"\)/, file);
    }
  });
});

describe("rayacash listen (proceso)", () => {
  test("reenvía con la firma de esta máquina y Ctrl+C sale con 0", { skip: !posix }, async () => {
    const event = sandboxEvent(1, "payment.created");
    const api = await startFakeApi({ json: page({ cursor: "c2" }) });
    const receiver = await startReceiver();
    try {
      api.enqueue({ json: page({ data: [event] }) });
      const dir = tempDir();
      const child = spawnCli(
        ["listen", "-f", `localhost:${receiver.port}/webhooks/raya`, "-e", "payment.*"],
        { dir, env: { RAYA_API_BASE: api.url, RAYA_SECRET_KEY: testKey("Cc2"), NO_COLOR: "1" } },
      );
      const done = collect(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await waitFor(() => receiver.hits.length === 1, "el reenvío");
      await waitFor(() => stderr.includes("Ctrl+C para salir."), "«Listo.»");
      const started = Date.now();
      child.kill("SIGINT");
      const result = await done;
      assert.equal(result.code, 0);
      assert.ok(Date.now() - started < 3_000);
      assert.match(result.stderr, /^Listo\. Escuchando el sandbox «Mi tienda»/m);
      assert.match(result.stderr, /Listo: dejamos de escuchar\.\n$/);
      assert.match(result.stdout, /--> payment\.created \[evt_0+1\]/);
      assert.match(
        result.stdout,
        new RegExp(
          `<-- \\[200\\] POST http://localhost:${receiver.port}/webhooks/raya \\[evt_0+1\\] \\d+ ms`,
        ),
      );
      // La firma verifica con el secreto que guardó (el de --print-secret).
      const secret = String(readConfig(configFile(dir)).webhook_secret);
      const hit = receiver.hits[0];
      assert.ok(hit);
      assert.deepEqual(hit.body, Buffer.from(event.body, "utf8"));
      const [t, v1] = String(hit.headers["raya-signature"]).split(",");
      const timestamp = Number(t?.slice(2));
      assert.equal(v1, `v1=${sign(secret, timestamp, hit.body)}`);
      assert.ok(Math.abs(Date.now() / 1000 - timestamp) < 60);
      // El sondeo pidió payment.* con la clave de RAYA_SECRET_KEY.
      assert.deepEqual(api.requests[0]?.json, { events: ["payment.*"] });
      assert.equal(api.requests[0]?.headers.authorization, `Bearer ${testKey("Cc2")}`);
    } finally {
      await api.close();
      await receiver.close();
    }
  });

  test("dos Ctrl+C casi juntos (npm y la terminal): igual sale con 0", {
    skip: !posix,
  }, async () => {
    const api = await startFakeApi();
    try {
      const child = spawnCli(["listen", "--api-key", testKey()], {
        dir: tempDir(),
        env: { RAYA_API_BASE: api.url },
      });
      const done = collect(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await waitFor(() => stderr.includes("Ctrl+C para salir."), "«Listo.»");
      child.kill("SIGINT");
      child.kill("SIGINT");
      const result = await done;
      assert.equal(result.code, 0);
      assert.match(result.stderr, /Listo: dejamos de escuchar\.\n$/);
    } finally {
      await api.close();
    }
  });

  test("Ctrl+C y la copia que reenvía npm unos ms después: siempre 0, nunca muerto por la señal", {
    skip: !posix,
  }, async () => {
    // npm exec le reenvía al hijo su copia del Ctrl+C de la terminal: si llega cuando el CLI ya
    // dejó de escuchar pero el proceso sigue vivo, sin handler Node aplicaría la acción por
    // defecto (muerto por SIGINT: el shell ve 130).
    const api = await startFakeApi();
    try {
      for (const delay of [0, 1, 2, 3, 4, 5, 1, 2, 3, 4]) {
        const child = spawnCli(["listen", "--api-key", testKey()], {
          dir: tempDir(),
          env: { RAYA_API_BASE: api.url },
        });
        const done = collect(child);
        let stderr = "";
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        await waitFor(() => stderr.includes("Ctrl+C para salir."), "«Listo.»");
        child.kill("SIGINT");
        await new Promise((resolve) => setTimeout(resolve, delay));
        child.kill("SIGINT");
        const result = await done;
        assert.deepEqual(
          [result.code, result.signal],
          [0, null],
          `a ${delay} ms: ${result.stderr}`,
        );
        assert.match(result.stderr, /Listo: dejamos de escuchar\.\n$/);
      }
    } finally {
      await api.close();
    }
  });

  test("NODE_TLS_REJECT_UNAUTHORIZED=0 no apaga la verificación de la API: la clave no viaja", {
    skip: !posix || testCerts() === null,
  }, async () => {
    const certs = testCerts();
    if (!certs) return;
    const api = await startFakeApi(undefined, { tls: certs.selfSigned });
    try {
      const child = spawnCli(["listen", "--api-key", testKey()], {
        dir: tempDir(),
        env: { RAYA_API_BASE: api.url, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      });
      const done = collect(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await waitFor(() => stderr.includes("NODE_EXTRA_CA_CERTS"), "la pista de la CA");
      child.kill("SIGINT");
      const result = await done;
      assert.equal(result.code, 0);
      // Ningún sondeo llegó: el TLS se cortó antes de mandar el Authorization.
      assert.equal(api.requests.length, 0);
      assert.ok(result.stderr.includes(MSG.tlsRejectIgnored));
      assert.match(
        result.stderr,
        /Sin conexión con la API de Raya Cash \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)\)/,
      );
      assert.ok(result.stderr.includes(MSG.apiTls));
      assert.equal(result.stderr.includes("Listo. Escuchando"), false);
      // Node no avisa nada en inglés: la variable ya no estaba cuando se conectó.
      assert.doesNotMatch(result.stderr, /Warning|insecure/);
    } finally {
      await api.close();
    }
  });

  test("con NODE_EXTRA_CA_CERTS (la pista), una API con una CA propia anda", {
    skip: !posix || testCerts() === null,
  }, async () => {
    const certs = testCerts();
    if (!certs) return;
    const api = await startFakeApi(undefined, { tls: certs.fromCa });
    try {
      const child = spawnCli(["listen", "--api-key", testKey()], {
        dir: tempDir(),
        env: { RAYA_API_BASE: api.url, NODE_EXTRA_CA_CERTS: certs.caFile },
      });
      const done = collect(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await waitFor(() => stderr.includes("Ctrl+C para salir."), "«Listo.»");
      child.kill("SIGINT");
      const result = await done;
      assert.equal(result.code, 0);
      assert.ok(api.requests.length >= 1);
    } finally {
      await api.close();
    }
  });

  test("con la salida cerrada (| head -n 1): corta en orden y sale con 0", {
    skip: !posix,
  }, async () => {
    const events = Array.from({ length: 50 }, (_, i) => sandboxEvent(i + 1));
    const api = await startFakeApi();
    try {
      api.enqueue({ json: page({ data: events }) });
      const child = spawnCli(["listen", "--json", "--api-key", testKey()], {
        dir: tempDir(),
        env: { RAYA_API_BASE: api.url },
      });
      child.stdout?.destroy();
      const result = await collect(child);
      assert.equal(result.code, 0);
      assert.doesNotMatch(result.stderr, /EPIPE|Unhandled/);
      assert.match(result.stderr, /Listo: dejamos de escuchar\.\n$/);
    } finally {
      await api.close();
    }
  });
});
