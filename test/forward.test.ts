import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UsageError } from "../src/args.ts";
import {
  classifyNetworkError,
  deliveryId,
  FORWARD_TIMEOUTS,
  forward,
  normalizeForwardUrl,
} from "../src/forward.ts";
import { sign } from "../src/signature.ts";
import { evtId, sandboxEvent, whsec } from "./helpers.ts";
import { startReceiver, testCerts } from "./receiver.ts";

const SECRET = whsec("Fw3");
const open = () => new AbortController().signal;

function headerPairs(raw: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i] ?? "", raw[i + 1] ?? ""]);
  return pairs;
}

describe("normalizeForwardUrl", () => {
  test("sin esquema, con puerto solo o con :puerto", () => {
    const cases: [string, string][] = [
      ["localhost:3000/webhooks/raya", "http://localhost:3000/webhooks/raya"],
      ["localhost:3000", "http://localhost:3000/"],
      [":3000/x", "http://localhost:3000/x"],
      ["3000", "http://localhost:3000/"],
      ["127.0.0.1:3000/x", "http://127.0.0.1:3000/x"],
      ["[::1]:3000/x", "http://[::1]:3000/x"],
      ["host.docker.internal:8080/x", "http://host.docker.internal:8080/x"],
      ["http://localhost:3000/a?b=1", "http://localhost:3000/a?b=1"],
      ["https://mi.local:8443/hooks", "https://mi.local:8443/hooks"],
      ["HTTPS://Mi.Local/x", "https://mi.local/x"],
      ["  localhost:8000/webhooks/raya  ", "http://localhost:8000/webhooks/raya"],
    ];
    for (const [raw, expected] of cases) assert.equal(normalizeForwardUrl(raw).href, expected, raw);
  });

  test("los errores", () => {
    const fails: [string, string][] = [
      ["ftp://x", "--forward-to tiene que ser http o https."],
      ["file:///etc/passwd", "--forward-to tiene que ser http o https."],
      ["usuario:clave@localhost:3000", "--forward-to no puede llevar usuario ni contraseña."],
      ["http://u:p@h/x", "--forward-to no puede llevar usuario ni contraseña."],
      [
        "mailto:x",
        "--forward-to no es una URL válida: usá algo como localhost:3000/webhooks/raya.",
      ],
      ["", "--forward-to no es una URL válida: usá algo como localhost:3000/webhooks/raya."],
      ["99999", "--forward-to no es una URL válida: usá algo como localhost:3000/webhooks/raya."],
      ["http://", "--forward-to no es una URL válida: usá algo como localhost:3000/webhooks/raya."],
    ];
    for (const [raw, message] of fails) {
      assert.throws(
        () => normalizeForwardUrl(raw),
        (error: unknown) => error instanceof UsageError && error.message === message,
        raw,
      );
    }
  });
});

describe("el reenvío", () => {
  test("los bytes exactos, sin reserializar (ñ, —, ✓, 1e-7, más de 2^53, NBSP, U+2028)", async () => {
    const receiver = await startReceiver();
    try {
      const id = evtId(1);
      // Como los manda la API (sin escapar lo no ASCII): NBSP y U+2028 van crudos.
      const body = `{"id":"${id}","object":"event","type":"payment.succeeded","livemode":false,"data":{"object":{"description":"Pedido ñandú — ✓ x y","rate":1e-7,"big":9007199254740993,"tab":"a\\tb"}}}`;
      assert.notEqual(JSON.stringify(JSON.parse(body)), body);
      const result = await forward(
        new URL(`${receiver.url}/webhooks/raya?x=1`),
        { id, type: "payment.succeeded", body },
        SECRET,
        { skipVerify: false, signal: open(), now: () => 1_700_000_000_999 },
      );
      assert.equal(result.status, 200);
      assert.ok((result.durationMs ?? -1) >= 0);
      const hit = receiver.hits[0];
      assert.ok(hit);
      assert.equal(hit.method, "POST");
      assert.equal(hit.path, "/webhooks/raya?x=1");
      assert.deepEqual(hit.body, Buffer.from(body, "utf8"));
      // Los headers de una entrega real, en orden.
      const pairs = headerPairs(hit.rawHeaders);
      const names = pairs.map(([name]) => name);
      const expected = [
        "Content-Type",
        "User-Agent",
        "Raya-Event-Id",
        "Raya-Event-Type",
        "Raya-Delivery-Id",
        "Raya-Signature",
        "Accept-Encoding",
        "Content-Length",
      ];
      assert.deepEqual(
        names.filter((name) => expected.includes(name)),
        expected,
      );
      assert.deepEqual(new Set(names), new Set([...expected, "Host", "Connection"]));
      const header = Object.fromEntries(pairs);
      assert.equal(header["Content-Type"], "application/json");
      assert.equal(header["User-Agent"], "Raya-Webhooks/1.0");
      assert.equal(header["Raya-Event-Id"], id);
      assert.equal(header["Raya-Event-Type"], "payment.succeeded");
      assert.match(header["Raya-Delivery-Id"] ?? "", /^whd_[0-9A-Za-z]{24}$/);
      assert.equal(
        header["Raya-Signature"],
        `t=1700000000,v1=${sign(SECRET, 1700000000, Buffer.from(body, "utf8"))}`,
      );
      assert.equal(header["Accept-Encoding"], "identity");
      assert.equal(header["Content-Length"], String(Buffer.byteLength(body)));
      assert.equal(header.Connection, "close");
    } finally {
      await receiver.close();
    }
  });

  test("un t y un Raya-Delivery-Id nuevos en cada reenvío", async () => {
    const receiver = await startReceiver();
    try {
      const event = sandboxEvent(2);
      let now = 1_700_000_000_000;
      for (let i = 0; i < 2; i += 1) {
        await forward(new URL(receiver.url), event, SECRET, {
          skipVerify: false,
          signal: open(),
          now: () => now,
        });
        now += 5_000;
      }
      const [first, second] = receiver.hits;
      assert.match(String(first?.headers["raya-signature"]), /^t=1700000000,/);
      assert.match(String(second?.headers["raya-signature"]), /^t=1700000005,/);
      assert.notEqual(first?.headers["raya-delivery-id"], second?.headers["raya-delivery-id"]);
      assert.notEqual(deliveryId(), deliveryId());
    } finally {
      await receiver.close();
    }
  });

  test("un 3xx no se sigue y un 4xx o 5xx se informa", async () => {
    const receiver = await startReceiver({
      reply: (hit) =>
        hit.path === "/redir"
          ? { status: 302, headers: { Location: "/otro" } }
          : { status: hit.path === "/400" ? 400 : 503, body: "no" },
    });
    try {
      const event = sandboxEvent(3);
      const options = { skipVerify: false, signal: open() };
      assert.equal(
        (await forward(new URL(`${receiver.url}/redir`), event, SECRET, options)).status,
        302,
      );
      assert.equal(receiver.hits.length, 1);
      assert.equal(
        (await forward(new URL(`${receiver.url}/400`), event, SECRET, options)).status,
        400,
      );
      assert.equal(
        (await forward(new URL(`${receiver.url}/x`), event, SECRET, options)).status,
        503,
      );
    } finally {
      await receiver.close();
    }
  });

  test("tu servidor no responde: timeout (con relojes cortos)", async () => {
    const receiver = await startReceiver({ reply: () => ({ hang: true }) });
    try {
      const result = await forward(new URL(receiver.url), sandboxEvent(4), SECRET, {
        skipVerify: false,
        signal: open(),
        timeouts: { responseMs: 50 },
      });
      assert.deepEqual(result, { error: "timeout", code: "ETIMEDOUT" });
      assert.deepEqual(FORWARD_TIMEOUTS, {
        connectMs: 5_000,
        responseMs: 15_000,
        drainMs: 5_000,
        maxBodyBytes: 65_536,
      });
    } finally {
      await receiver.close();
    }
  });

  test("no conecta a tiempo: como una conexión rechazada", async () => {
    const receiver = await startReceiver();
    try {
      // Con «localhost» hay que resolver el nombre antes de conectar, y eso llega por la I/O del
      // event loop. Frenado un momento, el timer (que corre antes que la I/O) gana siempre.
      const running = forward(
        new URL(receiver.url.replace("127.0.0.1", "localhost")),
        sandboxEvent(4),
        SECRET,
        { skipVerify: false, signal: open(), timeouts: { connectMs: 1 } },
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      assert.deepEqual(await running, { error: "refused", code: "ETIMEDOUT" });
    } finally {
      await receiver.close();
    }
  });

  test("conexión rechazada", async () => {
    const receiver = await startReceiver();
    const url = new URL(receiver.url);
    await receiver.close();
    const result = await forward(url, sandboxEvent(5), SECRET, {
      skipVerify: false,
      signal: open(),
    });
    assert.deepEqual(result, { error: "refused", code: "ECONNREFUSED" });
  });

  test("lee como mucho 64 KB de la respuesta (o lo que llegue en el tiempo de lectura)", async () => {
    const big = Buffer.alloc(200 * 1024, 0x61);
    const receiver = await startReceiver({
      reply: () => ({ status: 200, body: big, stream: true }),
    });
    try {
      const capped = await forward(new URL(receiver.url), sandboxEvent(6), SECRET, {
        skipVerify: false,
        signal: open(),
      });
      assert.equal(capped.status, 200);
      const slow = await startReceiver({
        reply: () => ({ status: 201, body: "poco", stream: true }),
      });
      try {
        const drained = await forward(new URL(slow.url), sandboxEvent(6), SECRET, {
          skipVerify: false,
          signal: open(),
          timeouts: { drainMs: 30 },
        });
        assert.equal(drained.status, 201);
      } finally {
        await slow.close();
      }
    } finally {
      await receiver.close();
    }
  });

  test("Ctrl+C en medio del reenvío lo corta", async () => {
    const receiver = await startReceiver({ reply: () => ({ hang: true }) });
    try {
      const stop = new AbortController();
      const running = forward(new URL(receiver.url), sandboxEvent(7), SECRET, {
        skipVerify: false,
        signal: stop.signal,
      });
      setTimeout(() => stop.abort(), 30);
      assert.deepEqual(await running, { error: "other", code: "ABORT_ERR" });
      stop.abort();
      const already = await forward(new URL(receiver.url), sandboxEvent(7), SECRET, {
        skipVerify: false,
        signal: stop.signal,
      });
      assert.deepEqual(already, { error: "other", code: "ABORT_ERR" });
    } finally {
      await receiver.close();
    }
  });

  test("un evento inválido no se firma ni se manda", async () => {
    const receiver = await startReceiver();
    try {
      const ok = sandboxEvent(8);
      const live = { ...ok, body: ok.body.replace('"livemode":false', '"livemode":true') };
      const result = await forward(new URL(receiver.url), live, SECRET, {
        skipVerify: false,
        signal: open(),
      });
      assert.deepEqual(result, { error: "invalid" });
      assert.equal(receiver.hits.length, 0);
    } finally {
      await receiver.close();
    }
  });
});

describe("TLS", () => {
  const certs = testCerts();
  const skip = certs === null ? "sin openssl en el PATH" : false;

  test("autofirmado: error de TLS sin --skip-verify; 200 con", { skip }, async () => {
    if (!certs) return;
    const receiver = await startReceiver({ tls: certs.selfSigned });
    try {
      const url = new URL(receiver.url);
      const strict = await forward(url, sandboxEvent(9), SECRET, {
        skipVerify: false,
        signal: open(),
      });
      assert.equal(strict.error, "tls");
      assert.match(strict.code ?? "", /SELF_SIGNED|DEPTH_ZERO/);
      const relaxed = await forward(url, sandboxEvent(9), SECRET, {
        skipVerify: true,
        signal: open(),
      });
      assert.equal(relaxed.status, 200);
    } finally {
      await receiver.close();
    }
  });

  test("una CA propia (mkcert, Valet, Herd): también es TLS", { skip }, async () => {
    if (!certs) return;
    const receiver = await startReceiver({ tls: certs.fromCa });
    try {
      const url = new URL(receiver.url);
      const strict = await forward(url, sandboxEvent(10), SECRET, {
        skipVerify: false,
        signal: open(),
      });
      assert.equal(strict.error, "tls");
      assert.match(strict.code ?? "", /^UNABLE_TO_/);
      const relaxed = await forward(url, sandboxEvent(10), SECRET, {
        skipVerify: true,
        signal: open(),
      });
      assert.equal(relaxed.status, 200);
    } finally {
      await receiver.close();
    }
  });

  test("https contra un servidor http: EPROTO", async () => {
    const receiver = await startReceiver();
    try {
      const url = new URL(receiver.url.replace("http:", "https:"));
      const result = await forward(url, sandboxEvent(11), SECRET, {
        skipVerify: false,
        signal: open(),
      });
      assert.equal(result.error, "tls");
      assert.match(result.code ?? "", /^(EPROTO|ERR_SSL_)/);
    } finally {
      await receiver.close();
    }
  });

  test("http contra un servidor que solo habla https: conectó y cortó (no «¿está corriendo?»)", {
    skip,
  }, async () => {
    if (!certs) return;
    const receiver = await startReceiver({ tls: certs.selfSigned });
    try {
      const url = new URL(receiver.url.replace("https:", "http:"));
      const result = await forward(url, sandboxEvent(12), SECRET, {
        skipVerify: false,
        signal: open(),
      });
      assert.deepEqual(result, { error: "reset", code: "ECONNRESET" });
    } finally {
      await receiver.close();
    }
  });
});

describe("classifyNetworkError", () => {
  test("cada familia", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH"]) {
      assert.deepEqual(classifyNetworkError(code, false), { error: "refused", code });
    }
    // Ya conectado, un corte es de tu servidor (que, por ejemplo, solo habla https).
    for (const code of ["ECONNRESET", "EPIPE"]) {
      assert.deepEqual(classifyNetworkError(code, false, true), { error: "reset", code });
      assert.deepEqual(classifyNetworkError(code, true, true), { error: "reset", code });
    }
    assert.deepEqual(classifyNetworkError("ECONNREFUSED", false, true), {
      error: "refused",
      code: "ECONNREFUSED",
    });
    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      assert.deepEqual(classifyNetworkError(code, false), { error: "dns", code });
    }
    for (const code of [
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "HOSTNAME_MISMATCH",
    ]) {
      assert.deepEqual(classifyNetworkError(code, true), { error: "tls", code });
    }
    assert.deepEqual(classifyNetworkError("EPROTO", true), { error: "tls", code: "EPROTO" });
    assert.deepEqual(classifyNetworkError("EPROTO", false), { error: "other", code: "EPROTO" });
    assert.deepEqual(classifyNetworkError("ENETUNREACH", false), {
      error: "other",
      code: "ENETUNREACH",
    });
  });
});
