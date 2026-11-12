import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, type ListenEvent, type ListenPage, type PollOptions } from "../src/api.ts";
import type { ForwardOptions, ForwardResult } from "../src/forward.ts";
import { type ListenDeps, type ListenOptions, runListen, sleep } from "../src/listen.ts";
import { MSG } from "../src/messages.ts";
import { ALL_EVENTS, SANDBOX } from "./fake-api.ts";
import { evtId, Sink, sandboxEvent, testKey, whsec } from "./helpers.ts";

const SECRET = whsec("Ls5");
const KEY = testKey("Zz9");

function pg(over: Partial<ListenPage> = {}): ListenPage {
  return {
    object: "webhook_listen",
    sandbox: { ...SANDBOX },
    events: [...ALL_EVENTS],
    data: [],
    has_more: false,
    cursor: "c1",
    gap: false,
    poll_interval_ms: 2000,
    ...over,
  };
}

const fail = (
  status: number,
  code: string | null = null,
  more: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ status, code, detail: MSG.detailStatus(status, code), ...more });

type Script = ListenPage | Error | ((poll: PollOptions) => Promise<ListenPage> | ListenPage);

interface Harness {
  run: Promise<number>;
  stdout: Sink;
  stderr: Sink;
  polls: PollOptions[];
  forwards: { target: URL; event: ListenEvent; secret: string; options: ForwardOptions }[];
  sleeps: number[];
  clock: { now: number };
  signal: () => void;
  /** Los handlers de señales que siguen puestos, y cuántas veces se llamó a su `off`. */
  handlers: Set<() => void>;
  offs: { count: number };
}

/** runListen con todo falso. Cuando se acaba el guion, «aprieta Ctrl+C». */
function harness(
  script: Script[],
  o: {
    options?: Partial<ListenOptions>;
    env?: Record<string, string>;
    tty?: boolean;
    forward?: (event: ListenEvent) => ForwardResult | Promise<ForwardResult>;
  } = {},
): Harness {
  const stdout = new Sink(o.tty ?? false);
  const stderr = new Sink(o.tty ?? false);
  const polls: PollOptions[] = [];
  const forwards: Harness["forwards"] = [];
  const sleeps: number[] = [];
  const clock = { now: Date.UTC(2026, 10, 12, 13, 31, 2) };
  const handlers = new Set<() => void>();
  const offs = { count: 0 };
  const signal = () => {
    for (const handler of handlers) handler();
  };
  const deps: ListenDeps = {
    api: async (poll) => {
      polls.push({ ...poll });
      const step = script.shift();
      if (step === undefined) {
        signal();
        throw new Error("fin del guion");
      }
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(poll) : step;
    },
    forward: async (target, event, secret, options) => {
      forwards.push({ target, event, secret, options });
      return o.forward ? o.forward(event) : { status: 200, durationMs: 18.4 };
    },
    stdout,
    stderr,
    env: o.env ?? {},
    sleep: async (ms, abort) => {
      sleeps.push(ms);
      clock.now += ms;
      if (!abort.aborted) await new Promise((resolve) => setImmediate(resolve));
    },
    now: () => clock.now,
    clock: () => new Date(2026, 10, 12, 10, 31, 2),
    random: () => 0.5,
    onSignal: (handler) => {
      handlers.add(handler);
      return () => {
        offs.count += 1;
        handlers.delete(handler);
      };
    },
  };
  const options: ListenOptions = {
    apiBase: "http://127.0.0.1:1",
    apiKey: KEY,
    events: ["*"],
    forwardTo: new URL("http://localhost:3000/webhooks/raya"),
    secret: SECRET,
    json: false,
    skipVerify: false,
    cmd: "rayacash",
    ...o.options,
  };
  return {
    run: runListen(options, deps),
    stdout,
    stderr,
    polls,
    forwards,
    sleeps,
    clock,
    signal,
    handlers,
    offs,
  };
}

const READY = [
  `Listo. Escuchando el sandbox «Mi tienda» (sbx_9fKc2LmQ8rT1uVwXyZ0aBcDe) con la clave raya_sk_test_…${KEY.slice(-4)}.`,
  `Eventos: ${ALL_EVENTS.join(", ")}`,
  "Reenviando a http://localhost:3000/webhooks/raya",
  `Secreto de firma: ${SECRET}  (en tu servidor, como RAYA_WEBHOOK_SECRET)`,
  "Ctrl+C para salir.",
];
const T = "2026-11-12 10:31:02";

describe("arranque", () => {
  test("«Listo.» recién con el primer 200, con el secreto entero", async () => {
    const h = harness([pg()]);
    assert.equal(await h.run, 0);
    assert.deepEqual(h.stderr.lines(), [...READY, "Listo: dejamos de escuchar."]);
    assert.equal(h.stdout.text, "");
    // El primer sondeo va sin cursor; el siguiente, con el de la respuesta.
    assert.deepEqual(
      h.polls.map((poll) => [poll.cursor, poll.events, poll.apiKey, poll.apiBase]),
      [
        [null, ["*"], KEY, "http://127.0.0.1:1"],
        ["c1", ["*"], KEY, "http://127.0.0.1:1"],
      ],
    );
  });

  test("«Listo.» dice de dónde salió la clave si no es la guardada", async () => {
    const env = harness([pg()], { options: { keySource: "env" } });
    await env.run;
    assert.equal(
      env.stderr.lines()[0],
      `Listo. Escuchando el sandbox «Mi tienda» (sbx_9fKc2LmQ8rT1uVwXyZ0aBcDe) con la clave raya_sk_test_…${KEY.slice(-4)} (de RAYA_SECRET_KEY).`,
    );
    const flag = harness([pg()], { options: { keySource: "flag" } });
    await flag.run;
    assert.match(flag.stderr.lines()[0] ?? "", /…\w{4} \(de --api-key\)\.$/);
    const saved = harness([pg()], { options: { keySource: "config" } });
    await saved.run;
    assert.equal(saved.stderr.lines()[0], READY[0]);
  });

  test("sin --forward-to: solo mostramos los eventos", async () => {
    const h = harness([pg({ data: [sandboxEvent(1)] })], { options: { forwardTo: null } });
    assert.equal(await h.run, 0);
    assert.equal(h.stderr.lines()[2], "Sin --forward-to: solo mostramos los eventos.");
    assert.deepEqual(h.stdout.lines(), [`${T}  --> payment.succeeded [${evtId(1)}]`]);
    assert.equal(h.forwards.length, 0);
  });

  test("los textos del servidor pasan limpios a la terminal", async () => {
    const event = sandboxEvent(2);
    const h = harness(
      [
        pg({
          sandbox: { id: "sbx_\u001b[2J1", name: "Mi\u0007 tienda\u009b" },
          events: ["payment.\u001bcreated"],
          data: [{ ...event, type: "payment.\u001b[31msucceeded" }],
        }),
      ],
      { options: { forwardTo: null } },
    );
    await h.run;
    assert.match(h.stderr.text, /el sandbox «Mi tienda» \(sbx_\[2J1\)/);
    assert.match(h.stderr.text, /^Eventos: payment\.created$/m);
    assert.equal(h.stdout.text.includes("\u001b"), false);
  });
});

describe("eventos", () => {
  test("en orden, en serie y una sola vez aunque la API los repita", async () => {
    const [a, b, c] = [sandboxEvent(1), sandboxEvent(2, "payment.created"), sandboxEvent(3)];
    const h = harness([pg({ data: [a, b] }), pg({ data: [b, c], cursor: "c2" })]);
    assert.equal(await h.run, 0);
    assert.deepEqual(
      h.forwards.map((call) => call.event.id),
      [a.id, b.id, c.id],
    );
    for (const call of h.forwards) {
      assert.equal(call.secret, SECRET);
      assert.equal(call.target.href, "http://localhost:3000/webhooks/raya");
      assert.equal(call.options.skipVerify, false);
    }
    assert.deepEqual(h.stdout.lines(), [
      `${T}  --> payment.succeeded [${a.id}]`,
      `${T}  <-- [200] POST http://localhost:3000/webhooks/raya [${a.id}] 18 ms`,
      `${T}  --> payment.created [${b.id}]`,
      `${T}  <-- [200] POST http://localhost:3000/webhooks/raya [${b.id}] 18 ms`,
      `${T}  --> payment.succeeded [${c.id}]`,
      `${T}  <-- [200] POST http://localhost:3000/webhooks/raya [${c.id}] 18 ms`,
    ]);
    assert.deepEqual(
      h.polls.map((poll) => poll.cursor),
      [null, "c1", "c2"],
    );
  });

  test("--json: stdout lleva solo los bodies, tal como llegan; las flechas van a stderr", async () => {
    const event = sandboxEvent(4);
    const h = harness([pg({ data: [event] })], { options: { json: true, skipVerify: true } });
    await h.run;
    assert.equal(h.stdout.text, `${event.body}\n`);
    assert.match(h.stderr.text, new RegExp(`--> payment\\.succeeded \\[${event.id}\\]`));
    assert.match(h.stderr.text, /<-- \[200\] POST/);
    assert.equal(h.forwards[0]?.options.skipVerify, true);
  });

  test("un evento inválido no se firma ni se reenvía (ni se muestra en --json)", async () => {
    const ok = sandboxEvent(5);
    const live = { ...ok, body: ok.body.replace('"livemode":false', '"livemode":true') };
    const h = harness([pg({ data: [live] })]);
    await h.run;
    assert.equal(h.forwards.length, 0);
    assert.deepEqual(h.stdout.lines(), [
      `${T}  --> payment.succeeded [${ok.id}]`,
      `${T}  <-- [ERROR] POST http://localhost:3000/webhooks/raya [${ok.id}] evento inválido: no lo reenviamos.`,
    ]);
    const json = harness([pg({ data: [live] })], { options: { json: true, forwardTo: null } });
    await json.run;
    assert.equal(json.stdout.text, "");
    assert.match(json.stderr.text, /<-- \[ERROR\] \[evt_0+5\] evento inválido: lo descartamos\./);
  });

  test("un tipo que no pediste no se firma ni se reenvía (ni se muestra en --json)", async () => {
    // Los tipos efectivos que devolvió la API son los únicos que se firman.
    const asked = ["payment.created", "payment.succeeded", "payment.refunded"];
    const ok = sandboxEvent(1, "payment.created");
    const extra = sandboxEvent(2, "connect.order.succeeded");
    const h = harness([pg({ events: asked, data: [ok, extra] })]);
    await h.run;
    assert.deepEqual(
      h.forwards.map((call) => call.event.id),
      [ok.id],
    );
    assert.deepEqual(h.stdout.lines().slice(2), [
      `${T}  --> connect.order.succeeded [${extra.id}]`,
      `${T}  <-- [ERROR] POST http://localhost:3000/webhooks/raya [${extra.id}] evento inválido: no lo reenviamos.`,
    ]);
    const json = harness([pg({ events: asked, data: [extra] })], {
      options: { json: true, forwardTo: null },
    });
    await json.run;
    assert.equal(json.stdout.text, "");
    assert.match(json.stderr.text, /<-- \[ERROR\] \[evt_0+2\] evento inválido: lo descartamos\./);
  });

  test("cada resultado del reenvío, con su línea", async () => {
    const results: ForwardResult[] = [
      { status: 302 },
      { status: 404, durationMs: 3.2 },
      { status: 500, durationMs: 7 },
      { status: 400, durationMs: 1 },
      { status: 401, durationMs: 1 },
      { error: "refused", code: "ECONNREFUSED" },
      { error: "timeout", code: "ETIMEDOUT" },
      { error: "tls", code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      { error: "tls", code: "EPROTO" },
      { error: "dns", code: "ENOTFOUND" },
      { error: "other", code: "ENETUNREACH" },
      { error: "other" },
      { error: "invalid" },
      { error: "reset", code: "ECONNRESET" },
    ];
    const events = results.map((_, i) => sandboxEvent(i + 1));
    const queue = [...results];
    const h = harness([pg({ data: events })], {
      options: { forwardTo: new URL("https://mi.local:8443/hooks?x=1") },
      forward: () => queue.shift() ?? { status: 200 },
    });
    await h.run;
    const url = "https://mi.local:8443/hooks?x=1";
    const back = h.stdout.lines().filter((line) => line.includes("<--"));
    const id = (i: number) => evtId(i + 1);
    assert.deepEqual(back, [
      `${T}  <-- [302] POST ${url} [${id(0)}] redirección: no la seguimos, como en las entregas reales`,
      `${T}  <-- [404] POST ${url} [${id(1)}] 3 ms`,
      `${T}  <-- [500] POST ${url} [${id(2)}] 7 ms`,
      `${T}  <-- [400] POST ${url} [${id(3)}] 1 ms`,
      `${T}  <-- [401] POST ${url} [${id(4)}] 1 ms`,
      `${T}  <-- [ERROR] POST ${url} [${id(5)}] no se pudo conectar: ¿está corriendo tu servidor en mi.local:8443?`,
      `${T}  <-- [ERROR] POST ${url} [${id(6)}] tu servidor no respondió en 15 s.`,
      `${T}  <-- [ERROR] POST ${url} [${id(7)}] error de TLS (DEPTH_ZERO_SELF_SIGNED_CERT). Si es un certificado local, probá con --skip-verify o sumá tu CA con NODE_EXTRA_CA_CERTS.`,
      `${T}  <-- [ERROR] POST ${url} [${id(8)}] tu servidor en mi.local:8443 no responde por https: ¿quisiste decir http://mi.local:8443/hooks?x=1?`,
      `${T}  <-- [ERROR] POST ${url} [${id(9)}] no encontramos el host mi.local.`,
      `${T}  <-- [ERROR] POST ${url} [${id(10)}] la conexión se cortó (ENETUNREACH).`,
      `${T}  <-- [ERROR] POST ${url} [${id(11)}] la conexión se cortó (?).`,
      `${T}  <-- [ERROR] POST ${url} [${id(12)}] evento inválido: no lo reenviamos.`,
      // Conectó y tu servidor cortó (https ya): sin la pista de https.
      `${T}  <-- [ERROR] POST ${url} [${id(13)}] tu servidor en mi.local:8443 cortó la conexión (ECONNRESET).`,
    ]);
    // La pista de la firma, una sola vez (con el primer 400, 401 o 403).
    assert.equal(
      h.stderr.lines().filter((line) => line === MSG.signatureHint("rayacash")).length,
      1,
    );
    assert.equal(
      MSG.signatureHint("rayacash"),
      "Si tu servidor rechaza la firma, revisá que RAYA_WEBHOOK_SECRET sea el de rayacash listen --print-secret (no el de un destino del dashboard).",
    );
  });

  test("conectó y tu servidor cortó: si -f es http, la pista de https", async () => {
    const queue: ForwardResult[] = [
      { error: "reset", code: "ECONNRESET" },
      { error: "reset", code: "EPIPE" },
    ];
    const h = harness([pg({ data: [sandboxEvent(1), sandboxEvent(2)] })], {
      options: { forwardTo: new URL("http://localhost:3000/webhooks/raya?x=1") },
      forward: () => queue.shift() ?? { status: 200 },
    });
    await h.run;
    const back = h.stdout.lines().filter((line) => line.includes("<--"));
    assert.deepEqual(back, [
      `${T}  <-- [ERROR] POST http://localhost:3000/webhooks/raya?x=1 [${evtId(1)}] tu servidor en localhost:3000 cortó la conexión: si usa https, probá -f https://localhost:3000/webhooks/raya?x=1`,
      `${T}  <-- [ERROR] POST http://localhost:3000/webhooks/raya?x=1 [${evtId(2)}] tu servidor en localhost:3000 cortó la conexión: si usa https, probá -f https://localhost:3000/webhooks/raya?x=1`,
    ]);
    // «¿Está corriendo…?» queda para cuando no conecta.
    assert.equal(h.stdout.text.includes("está corriendo"), false);
  });

  test("el puerto por defecto en la pista de conexión", async () => {
    const queue: ForwardResult[] = [{ error: "refused", code: "ECONNREFUSED" }];
    const http = harness([pg({ data: [sandboxEvent(1)] })], {
      options: { forwardTo: new URL("http://localhost/x") },
      forward: () => queue.shift() ?? { status: 200 },
    });
    await http.run;
    assert.match(http.stdout.text, /tu servidor en localhost:80\?/);
    const tls: ForwardResult[] = [{ error: "tls", code: "EPROTO" }];
    const https = harness([pg({ data: [sandboxEvent(1)] })], {
      options: { forwardTo: new URL("https://localhost/x") },
      forward: () => tls.shift() ?? { status: 200 },
    });
    await https.run;
    assert.match(
      https.stdout.text,
      /localhost:443 no responde por https: ¿quisiste decir http:\/\/localhost\/x\?/,
    );
  });

  test("colores: verde, amarillo y rojo en una terminal; nada sin terminal o con NO_COLOR", async () => {
    const results: ForwardResult[] = [{ status: 200 }, { status: 404 }, { status: 500 }];
    const run = async (o: { tty: boolean; env?: Record<string, string> }) => {
      const queue = [...results];
      const h = harness([pg({ data: [sandboxEvent(1), sandboxEvent(2), sandboxEvent(3)] })], {
        ...o,
        forward: () => queue.shift() ?? { status: 200 },
      });
      await h.run;
      return h.stdout.text;
    };
    const colored = await run({ tty: true });
    assert.ok(colored.includes("\u001b[32m<-- [200]"));
    assert.ok(colored.includes("\u001b[33m<-- [404]"));
    assert.ok(colored.includes("\u001b[31m<-- [500]"));
    const plain: { tty: boolean; env?: Record<string, string> }[] = [
      { tty: false },
      { tty: true, env: { NO_COLOR: "1" } },
      { tty: true, env: { TERM: "dumb" } },
    ];
    for (const o of plain) {
      assert.equal((await run(o)).includes("\u001b["), false, JSON.stringify(o));
    }
    assert.ok((await run({ tty: false, env: { FORCE_COLOR: "1" } })).includes("\u001b[32m"));
  });

  test("recuerda 10.000 eventos: el más viejo sale", async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => ({
      id: evtId(i),
      type: "payment.created",
      body: "{}",
    }));
    const first = many[0];
    assert.ok(first);
    const h = harness([pg({ data: many }), pg({ data: [first, many[10_000] ?? first] })], {
      options: { forwardTo: null },
    });
    await h.run;
    const shown = h.stdout
      .lines()
      .filter((line) => line.includes(`--> payment.created [${first.id}]`));
    assert.equal(shown.length, 2);
  });
});

describe("el ritmo de los sondeos", () => {
  test("poll_interval_ms acotado a [1 s, 30 s]; has_more vuelve enseguida", async () => {
    const h = harness([
      pg({ poll_interval_ms: 2000 }),
      pg({ poll_interval_ms: 10 }),
      pg({ poll_interval_ms: 120_000 }),
      pg({ has_more: true, cursor: "c9" }),
      pg({ poll_interval_ms: 1500 }),
    ]);
    await h.run;
    assert.deepEqual(h.sleeps, [2000, 1000, 30000, 1500]);
    assert.deepEqual(
      h.polls.map((poll) => poll.cursor),
      [null, "c1", "c1", "c1", "c9", "c1"],
    );
  });

  test("gap: el aviso de que pudo faltar algo, una vez por racha", async () => {
    const h = harness([pg(), pg({ gap: true })]);
    await h.run;
    assert.equal(h.stderr.lines().filter((line) => line === MSG.gap).length, 1);
    // Si la API no puede mantener la escucha, cada sondeo trae gap: el aviso no se repite hasta que pase.
    const streak = harness([
      pg(),
      pg({ gap: true }),
      pg({ gap: true }),
      pg({ gap: true }),
      pg(),
      pg({ gap: true }),
    ]);
    await streak.run;
    assert.equal(streak.stderr.lines().filter((line) => line === MSG.gap).length, 2);
    // Neutro: el corte puede ser de la conexión del integrador o del lado de la API.
    assert.equal(
      MSG.gap,
      "La escucha estuvo cortada un rato: los eventos que ocurrieron mientras tanto pueden no haberte llegado. Seguimos escuchando.",
    );
  });

  test("429: espera Retry-After y va más despacio por 10 minutos (el doble, hasta 10 s)", async () => {
    const limited = (seconds: string | null) =>
      fail(429, "RATE_LIMITED", { retryAfter: seconds === null ? null : Number(seconds) });
    const h = harness([
      pg(),
      limited("3"),
      pg(),
      limited("120"),
      pg(),
      limited(null),
      pg(),
      (poll) => {
        h.clock.now += 11 * 60_000;
        return pg({ cursor: poll.cursor ?? "c1" });
      },
    ]);
    await h.run;
    // 2 s; 429 → 3 s; 4 s; 429 → 60 s (tope); 8 s; 429 → 5 s (sin Retry-After); 10 s (tope);
    // pasados los 10 minutos, 2 s otra vez.
    assert.deepEqual(h.sleeps, [2000, 3000, 4000, 60_000, 8000, 5000, 10_000, 2000]);
    // El aviso, como mucho una vez por minuto.
    assert.deepEqual(
      h.stderr.lines().filter((line) => line === MSG.slowDown),
      [MSG.slowDown, MSG.slowDown],
    );
    assert.equal(MSG.slowDown, "Tu cuenta tiene muchas escuchas abiertas: vamos más despacio.");
  });

  test("cursor inválido: retoma desde ahora", async () => {
    const h = harness([
      pg(),
      fail(400, "PARAMETER_INVALID", { data: { field: "cursor" }, serverMessage: "El cursor…" }),
      pg({ cursor: "nuevo" }),
    ]);
    assert.equal(await h.run, 0);
    assert.ok(h.stderr.lines().includes("Retomamos la escucha desde ahora."));
    assert.deepEqual(
      h.polls.map((poll) => poll.cursor),
      [null, "c1", null, "nuevo"],
    );
    // «Listo.» una sola vez.
    assert.equal(h.stderr.lines().filter((line) => line.startsWith("Listo. ")).length, 1);
  });
});

describe("sin conexión", () => {
  test("backoff 1, 2, 4… con un aviso por racha, y «Conectado de nuevo.» al volver", async () => {
    const network = new ApiError({ status: 0, detail: "ECONNREFUSED", network: true });
    const h = harness([
      pg(),
      network,
      fail(502),
      fail(503, "TEMPORARILY_UNAVAILABLE"),
      new ApiError({ status: 200, detail: MSG.detailUnexpected }),
      pg(),
      network,
      pg(),
    ]);
    assert.equal(await h.run, 0);
    assert.deepEqual(h.sleeps, [2000, 1000, 2000, 4000, 8000, 2000, 1000, 2000]);
    const notes = h.stderr.lines().slice(READY.length);
    assert.deepEqual(notes, [
      "Sin conexión con la API de Raya Cash (ECONNREFUSED): reintentamos en 1 s.",
      "Conectado de nuevo.",
      "Sin conexión con la API de Raya Cash (ECONNREFUSED): reintentamos en 1 s.",
      "Conectado de nuevo.",
      "Listo: dejamos de escuchar.",
    ]);
  });

  test("antes del primer 200 también reintenta (sin «Conectado de nuevo.»), y con un proxy definido lo dice", async () => {
    const network = new ApiError({ status: 0, detail: "ENOTFOUND", network: true });
    const h = harness([network, network, pg()], { env: { HTTPS_PROXY: "http://proxy:8080" } });
    assert.equal(await h.run, 0);
    assert.deepEqual(h.stderr.lines().slice(0, 3), [
      "Sin conexión con la API de Raya Cash (ENOTFOUND): reintentamos en 1 s.",
      "Tenés HTTPS_PROXY definida: rayacash-cli 1.0 no pasa por proxies.",
      READY[0],
    ]);
    // Nunca se había conectado: no hay «de nuevo».
    assert.equal(h.stderr.text.includes(MSG.reconnected), false);
    for (const first of [fail(503, "TEMPORARILY_UNAVAILABLE"), fail(502)]) {
      const start = harness([first, pg()]);
      await start.run;
      assert.equal(start.stderr.lines()[1], READY[0]);
      assert.equal(start.stderr.text.includes(MSG.reconnected), false);
    }
    // Sin la red de por medio (un 502), no hay pista de proxy.
    const other = harness([fail(502), pg()], { env: { http_proxy: "http://proxy:8080" } });
    await other.run;
    assert.equal(other.stderr.text.includes("proxies"), false);
  });

  test("la pista de proxies no sale si Node ya usa el proxy (NODE_USE_ENV_PROXY o --use-env-proxy)", async () => {
    const network = new ApiError({ status: 0, detail: "ECONNREFUSED", network: true });
    const envs: Record<string, string>[] = [
      { HTTPS_PROXY: "http://proxy:8080", NODE_USE_ENV_PROXY: "1" },
      { HTTPS_PROXY: "http://proxy:8080", NODE_OPTIONS: "--max-old-space-size=99 --use-env-proxy" },
    ];
    for (const env of envs) {
      const h = harness([network, pg()], { env });
      await h.run;
      assert.equal(h.stderr.text.includes("proxies"), false, JSON.stringify(env));
    }
  });

  test("un certificado que no verifica: la pista de NODE_EXTRA_CA_CERTS, una vez", async () => {
    const tls = (code: string) => new ApiError({ status: 0, detail: code, network: true });
    const h = harness([
      tls("DEPTH_ZERO_SELF_SIGNED_CERT"),
      tls("DEPTH_ZERO_SELF_SIGNED_CERT"),
      pg(),
      tls("SELF_SIGNED_CERT_IN_CHAIN"),
      pg(),
    ]);
    assert.equal(await h.run, 0);
    const hints = h.stderr.lines().filter((line) => line === MSG.apiTls);
    assert.equal(hints.length, 1);
    assert.equal(
      MSG.apiTls,
      "No pudimos verificar el certificado de la API de Raya Cash. Si tu red (un proxy de tu empresa o un antivirus) intercepta HTTPS, sumá su CA con NODE_EXTRA_CA_CERTS.",
    );
    assert.equal(h.stderr.lines()[1], MSG.apiTls);
    // Ni con una red caída ni con un 5xx.
    const other = harness([new ApiError({ status: 0, detail: "ECONNRESET", network: true }), pg()]);
    await other.run;
    assert.equal(other.stderr.text.includes("NODE_EXTRA_CA_CERTS"), false);
  });

  test("503 API_UNAVAILABLE al arrancar: exit 1 con el texto neutro", async () => {
    const h = harness([
      fail(503, "API_UNAVAILABLE", { serverMessage: "La API no está disponible." }),
    ]);
    assert.equal(await h.run, 1);
    assert.deepEqual(h.stderr.lines(), [
      "La API de Raya Cash o el sandbox de tu cuenta no están disponibles en este momento. Si en el menú de tu perfil del dashboard no aparece «Crear sandbox» ni «Sandboxes», tu cuenta todavía no lo tiene.",
    ]);
  });

  test("503 API_UNAVAILABLE después: reintenta cada 30 s, con un aviso", async () => {
    const off = fail(503, "API_UNAVAILABLE");
    const h = harness([pg(), off, off, pg()]);
    assert.equal(await h.run, 0);
    assert.deepEqual(h.sleeps, [2000, 30_000, 30_000, 2000]);
    assert.deepEqual(h.stderr.lines().slice(READY.length), [
      "La API no está disponible por ahora: reintentamos en 30 s.",
      "Conectado de nuevo.",
      "Listo: dejamos de escuchar.",
    ]);
  });
});

describe("la API dice que no", () => {
  const cases: [string, ApiError, number, string][] = [
    [
      "eventos inválidos: el mensaje del servidor (exit 2)",
      fail(400, "PARAMETER_INVALID", {
        data: { field: "events" },
        serverMessage:
          "No existe el evento payment.succeded. ¿Quisiste decir payment.succeeded?\u001b[0m",
      }),
      2,
      "No existe el evento payment.succeded. ¿Quisiste decir payment.succeeded?[0m",
    ],
    [
      "otro 400",
      fail(400, "PARAMETER_UNKNOWN", { data: { field: "x" }, serverMessage: "No conocemos x." }),
      1,
      MSG.incompatible("rayacash"),
    ],
    [
      "un PARAMETER_INVALID de events sin mensaje",
      fail(400, "PARAMETER_INVALID", { data: { field: "events" } }),
      1,
      MSG.incompatible("rayacash"),
    ],
    ["413", fail(413, "REQUEST_TOO_LARGE"), 1, MSG.incompatible("rayacash")],
    ["409", fail(409), 1, MSG.incompatible("rayacash")],
    [
      "la clave no es válida",
      fail(401, "API_KEY_INVALID", { serverMessage: "La clave no es válida." }),
      1,
      "La clave no es válida: revisá que sea la clave secreta de prueba de un sandbox que exista (Developers › API Keys, adentro del sandbox) y guardala de nuevo con rayacash login.",
    ],
    [
      "la clave venció",
      fail(401, "API_KEY_EXPIRED", { serverMessage: "La clave venció." }),
      1,
      "La clave venció o se revocó (también pasa si eliminaste el sandbox). Copiá la vigente en Developers › API Keys del sandbox y guardala con rayacash login.",
    ],
    [
      "otro 403, con motivo",
      fail(403, "API_KEY_ACCOUNT_LOCKED", {
        serverMessage: "La cuenta de esta clave está bloqueada.",
        data: { reason: "compliance" },
      }),
      1,
      "La cuenta de esta clave está bloqueada. (motivo: compliance)",
    ],
    [
      "otro 403, sin motivo",
      fail(403, "SANDBOX_ONLY", { serverMessage: "Solo sandbox.", data: { reason: "" } }),
      1,
      "Solo sandbox.",
    ],
    ["otro 401", fail(401, "API_KEY_MISSING", { serverMessage: "Falta." }), 1, "Falta."],
    ["un 403 sin envelope (un proxy)", fail(403), 1, MSG.rejected(403)],
    ["404", fail(404, "NOT_FOUND"), 1, MSG.notFound(404, "rayacash")],
    ["405 en HTML", fail(405), 1, MSG.notFound(405, "rayacash")],
    ["una redirección", fail(301), 1, MSG.redirect(301, "rayacash")],
  ];
  for (const [name, error, code, message] of cases) {
    test(name, async () => {
      const h = harness([pg(), error]);
      assert.equal(await h.run, code);
      assert.equal(h.stderr.lines().at(-1), message);
      // Nunca se reintenta.
      assert.equal(h.polls.length, 2);
    });
  }

  test("un cursor inválido en el primer sondeo (sin cursor): incompatible", async () => {
    const h = harness([
      fail(400, "PARAMETER_INVALID", { data: { field: "cursor" }, serverMessage: "x" }),
    ]);
    assert.equal(await h.run, 1);
    assert.deepEqual(h.stderr.lines(), [MSG.incompatible("rayacash")]);
  });

  test("los textos con {cmd} y el soporte", () => {
    assert.equal(
      MSG.notFound(404, "rayacash"),
      "La API de Raya Cash no reconoce la escucha de eventos (404). Actualizá rayacash-cli (npm install -g rayacash-cli) o escribinos a soporte@raya.cash.",
    );
    assert.equal(
      MSG.incompatible("rayacash"),
      "Esta versión de rayacash-cli no es compatible con la API de Raya Cash. Actualizala con npm install -g rayacash-cli.",
    );
    // Con npx, instalarlo global no cambia lo que corre npx: la última se pide con @latest.
    assert.equal(
      MSG.incompatible("npx rayacash-cli"),
      "Esta versión de rayacash-cli no es compatible con la API de Raya Cash. Actualizala con npx rayacash-cli@latest listen.",
    );
    assert.equal(
      MSG.notFound(405, "npx rayacash-cli"),
      "La API de Raya Cash no reconoce la escucha de eventos (405). Actualizá rayacash-cli (npx rayacash-cli@latest listen) o escribinos a soporte@raya.cash.",
    );
    assert.match(MSG.redirect(307, "npx rayacash-cli"), /\(npx rayacash-cli@latest listen\)/);
    assert.match(MSG.redirect(307, "rayacash"), /\(npm install -g rayacash-cli\)/);
    assert.match(
      MSG.keyRejected("npx rayacash-cli"),
      /guardala de nuevo con npx rayacash-cli login\.$/,
    );
    assert.match(MSG.keyExpired("npx rayacash-cli"), /guardala con npx rayacash-cli login\.$/);
  });

  test("un error que no es de la API es un bug: no se reintenta en silencio", async () => {
    const h = harness([new TypeError("x is not a function")]);
    await assert.rejects(h.run, TypeError);
  });
});

describe("Ctrl+C", () => {
  test("el primero corta lo que esté en curso y sale con 0", async () => {
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = harness([
      pg(),
      (poll) =>
        new Promise<ListenPage>((_resolve, reject) => {
          started();
          poll.signal.addEventListener("abort", () => reject(new Error("abortado")));
        }),
    ]);
    await waiting;
    h.signal();
    assert.equal(await h.run, 0);
    assert.equal(h.stderr.lines().at(-1), "Listo: dejamos de escuchar.");
  });

  test("durante un reenvío: no imprime el resultado", async () => {
    let h: Harness | undefined;
    h = harness([pg({ data: [sandboxEvent(1), sandboxEvent(2)] })], {
      forward: () => {
        h?.signal();
        return { error: "other", code: "ABORT_ERR" };
      },
    });
    assert.equal(await h.run, 0);
    assert.equal(h.stdout.lines().length, 1);
    assert.equal(h.forwards.length, 1);
  });

  test("durante la espera entre sondeos", async () => {
    const h = harness([pg()]);
    // El guion se acaba en el segundo sondeo y aprieta Ctrl+C: la espera de 2 s terminó antes.
    assert.equal(await h.run, 0);
    const stopped = harness([pg({ data: [sandboxEvent(1)] })], { options: { forwardTo: null } });
    assert.equal(await stopped.run, 0);
    let real = 0;
    const abort = new AbortController();
    const start = Date.now();
    const pending = sleep(5_000, abort.signal).then(() => {
      real = Date.now() - start;
    });
    setTimeout(() => abort.abort(), 20);
    await pending;
    assert.ok(real < 1_000);
    await sleep(5_000, abort.signal);
    await sleep(5, new AbortController().signal);
  });

  test("después de un Ctrl+C el handler queda puesto (la copia de npm no mata el proceso)", async () => {
    const h = harness([pg()]);
    // El guion se acaba y «aprieta Ctrl+C»: el apagado lo pidió una señal.
    assert.equal(await h.run, 0);
    assert.equal(h.offs.count, 0);
    assert.equal(h.handlers.size, 1);
    // La copia que reenvía npm, ya sin escucha: el handler la absorbe sin hacer nada.
    h.signal();
    h.clock.now += 5_000;
    h.signal();
    // Si termina por otra cosa (un error que reintentar no arregla), se saca.
    const failed = harness([pg(), fail(401, "API_KEY_INVALID", { serverMessage: "No." })]);
    assert.equal(await failed.run, 1);
    assert.equal(failed.offs.count, 1);
    assert.equal(failed.handlers.size, 0);
  });

  test("un segundo Ctrl+C cuenta solo si llega un segundo o más después del primero", async () => {
    let calls = 0;
    const h = harness([
      pg(),
      // Un sondeo que ni el apagado corta (para ver el segundo Ctrl+C).
      () => {
        calls += 1;
        return new Promise<ListenPage>(() => {});
      },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
    h.signal();
    // npm y la terminal mandan el mismo Ctrl+C dos veces casi juntas: no cuenta.
    h.clock.now += 10;
    h.signal();
    let settled = false;
    void h.run.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    h.clock.now += 1_000;
    h.signal();
    assert.equal(await h.run, 130);
  });
});
