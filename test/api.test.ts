import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ApiError, parsePage, parseRetryAfter, pollEvents, userAgent } from "../src/api.ts";
import { apiError, type FakeApi, page, SANDBOX, startFakeApi } from "./fake-api.ts";
import { sandboxEvent, testKey } from "./helpers.ts";

let api: FakeApi;

before(async () => {
  api = await startFakeApi();
});

after(async () => {
  await api.close();
});

function poll(over: Partial<Parameters<typeof pollEvents>[0]> = {}) {
  return pollEvents({
    apiBase: api.url,
    apiKey: testKey(),
    events: ["*"],
    cursor: null,
    signal: new AbortController().signal,
    ...over,
  });
}

async function failure(run: Promise<unknown>): Promise<ApiError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof ApiError, String(error));
    return error;
  }
  assert.fail("tenía que fallar");
}

describe("el sondeo", () => {
  test("POST con Bearer, JSON y el User-Agent; nunca Raya-Sandbox", async () => {
    const event = sandboxEvent(1);
    api.enqueue({ json: page({ data: [event], cursor: "c2" }) });
    const result = await poll({ events: ["payment.*", "connect.order.*"] });
    const request = api.requests.at(-1);
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/test/webhooks/listen");
    assert.equal(request.headers.authorization, `Bearer ${testKey()}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers["user-agent"], userAgent());
    assert.match(userAgent(), /^rayacash-cli\/1\.0\.0 Node\/\d+\.\d+\.\d+( undici\/\S+)?$/);
    assert.equal(request.headers["raya-sandbox"], undefined);
    // El primer sondeo va sin cursor.
    assert.deepEqual(request.json, { events: ["payment.*", "connect.order.*"] });
    assert.deepEqual(result, page({ data: [event], cursor: "c2" }));
    assert.equal(result.data[0]?.body, event.body);
  });

  test("el cursor vuelve tal cual", async () => {
    api.enqueue({ json: page() });
    await poll({ cursor: "eyJ2IjoxfQ" });
    assert.deepEqual(api.requests.at(-1)?.json, { events: ["*"], cursor: "eyJ2IjoxfQ" });
  });

  test("una redirección no se sigue (la clave no sale de la API)", async () => {
    const before = api.requests.length;
    api.enqueue({ status: 307, headers: { Location: `${api.url}/otra` } });
    const error = await failure(poll());
    assert.equal(error.status, 307);
    assert.equal(api.requests.length, before + 1);
  });

  test("el envelope de error: código, mensaje, data y Retry-After", async () => {
    api.enqueue(
      apiError(429, "RATE_LIMITED", "Hiciste muchas requests.", null, { "Retry-After": "12" }),
    );
    const limited = await failure(poll());
    assert.equal(limited.status, 429);
    assert.equal(limited.code, "RATE_LIMITED");
    assert.equal(limited.serverMessage, "Hiciste muchas requests.");
    assert.equal(limited.retryAfter, 12);
    assert.equal(limited.detail, "429 RATE_LIMITED");
    assert.equal(limited.network, false);

    api.enqueue(
      apiError(403, "API_KEY_ACCOUNT_LOCKED", "La cuenta está bloqueada.", { reason: "kyc" }),
    );
    const locked = await failure(poll());
    assert.deepEqual(
      [locked.status, locked.code, locked.data, locked.retryAfter],
      [403, "API_KEY_ACCOUNT_LOCKED", { reason: "kyc" }, null],
    );

    api.enqueue({
      status: 400,
      json: { error: { code: "PARAMETER_INVALID", data: { field: "x" } } },
    });
    const noMessage = await failure(poll());
    assert.equal(noMessage.serverMessage, "");
    assert.equal(noMessage.message, "400 PARAMETER_INVALID");
  });

  test("HTML de un proxy o JSON ajeno: sin código", async () => {
    api.enqueue({ status: 502, body: "<html>Bad gateway</html>" });
    const html = await failure(poll());
    assert.deepEqual([html.status, html.code, html.detail], [502, null, "HTTP 502"]);
    api.enqueue({ status: 404, json: { detail: "Not found." } });
    const other = await failure(poll());
    assert.deepEqual([other.status, other.code], [404, null]);
    api.enqueue({ status: 500, json: { error: "texto" } });
    assert.equal((await failure(poll())).code, null);
  });

  test("un 200 con otra forma es una respuesta inesperada", async () => {
    const bad = [
      "{roto",
      "[]",
      JSON.stringify({ ...page(), object: "list" }),
      JSON.stringify({ ...page(), sandbox: null }),
      JSON.stringify({ ...page(), sandbox: { id: "sbx", name: 1 } }),
      JSON.stringify({ ...page(), events: "payment.*" }),
      JSON.stringify({ ...page(), events: [1] }),
      JSON.stringify({ ...page(), data: {} }),
      JSON.stringify({ ...page(), data: [{ id: "evt_corto", type: "x", body: "{}" }] }),
      JSON.stringify({ ...page(), data: [{ ...sandboxEvent(1), body: {} }] }),
      JSON.stringify({ ...page(), data: [{ ...sandboxEvent(1), type: null }] }),
      JSON.stringify({ ...page(), has_more: "no" }),
      JSON.stringify({ ...page(), gap: 0 }),
      JSON.stringify({ ...page(), cursor: "" }),
      JSON.stringify({ ...page(), cursor: 5 }),
      JSON.stringify({ ...page(), poll_interval_ms: "2000" }),
      JSON.stringify({ ...page(), poll_interval_ms: null }),
    ];
    for (const body of bad) {
      api.enqueue({ status: 200, body });
      const error = await failure(poll());
      assert.deepEqual([error.status, error.detail], [200, "respuesta inesperada"], body);
    }
    // UTF-8 inválido tampoco.
    api.enqueue({ status: 200, body: Buffer.from([0x7b, 0xff, 0x7d]) });
    assert.equal((await failure(poll())).detail, "respuesta inesperada");
  });

  test("la página se copia sin claves de más", () => {
    const parsed = parsePage(
      Buffer.from(
        JSON.stringify(
          page({ extra: 1, sandbox: { ...SANDBOX, x: 2 }, data: [{ ...sandboxEvent(2), x: 3 }] }),
        ),
      ),
    );
    assert.deepEqual(parsed, page({ data: [sandboxEvent(2)] }));
  });

  test("sin respuesta a tiempo: timeout", async () => {
    api.enqueue({ json: page(), delayMs: 500 });
    const error = await failure(poll({ timeoutMs: 50 }));
    assert.deepEqual(
      [error.status, error.detail, error.network],
      [0, "no respondió en 15 s", true],
    );
  });

  test("una respuesta demasiado grande", async () => {
    api.enqueue({ json: page({ data: [sandboxEvent(3)] }) });
    const error = await failure(poll({ maxBytes: 64 }));
    assert.deepEqual([error.status, error.detail], [0, "respuesta demasiado grande"]);
  });

  test("sin conexión: el código de la causa", async () => {
    const closed = await startFakeApi();
    const url = closed.url;
    await closed.close();
    const error = await failure(poll({ apiBase: url }));
    assert.equal(error.status, 0);
    assert.equal(error.network, true);
    assert.equal(error.detail, "ECONNREFUSED");
  });

  test("un host que la guarda no deja: error de red sin código", async () => {
    // La guarda corta antes de resolver el nombre: la causa no trae código.
    const error = await failure(poll({ apiBase: "http://127.0.0.1:9" }));
    assert.equal(error.status, 0);
    assert.equal(error.detail, "error de red");
  });

  test("el apagado (Ctrl+C) no es un ApiError: sale tal cual", async () => {
    const stop = new AbortController();
    api.enqueue({ json: page(), delayMs: 300 });
    const running = poll({ signal: stop.signal });
    setTimeout(() => stop.abort(), 20);
    await assert.rejects(running, (error: unknown) => !(error instanceof ApiError));
  });
});

describe("Retry-After", () => {
  test("solo segundos", () => {
    assert.equal(parseRetryAfter("30"), 30);
    assert.equal(parseRetryAfter(" 7 "), 7);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"), null);
    assert.equal(parseRetryAfter("-1"), null);
    assert.equal(parseRetryAfter("1.5"), null);
  });
});
