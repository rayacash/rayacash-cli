import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { networkDetail } from "../src/api.ts";
import { DEFAULT_API_BASE, resolveApiBase } from "../src/apiBase.ts";
import { UsageError } from "../src/args.ts";

describe("RAYA_API_BASE", () => {
  test("sin definir (o vacía): la API de Raya Cash, sin aviso", () => {
    assert.deepEqual(resolveApiBase({}), { base: DEFAULT_API_BASE, custom: false });
    assert.deepEqual(resolveApiBase({ RAYA_API_BASE: "  " }), {
      base: DEFAULT_API_BASE,
      custom: false,
    });
    assert.equal(DEFAULT_API_BASE, "https://api.raya.cash");
  });

  test("https con o sin puerto; http solo para localhost, 127.0.0.1 y [::1]", () => {
    const ok: [string, string][] = [
      ["https://api.ejemplo.com", "https://api.ejemplo.com"],
      ["https://api.ejemplo.com/", "https://api.ejemplo.com"],
      ["https://api.ejemplo.com:8443", "https://api.ejemplo.com:8443"],
      ["http://localhost:8080", "http://localhost:8080"],
      ["http://127.0.0.1:65000/", "http://127.0.0.1:65000"],
      ["http://[::1]:9000", "http://[::1]:9000"],
      [" HTTPS://API.Ejemplo.com ", "https://api.ejemplo.com"],
    ];
    for (const [raw, base] of ok) {
      assert.deepEqual(resolveApiBase({ RAYA_API_BASE: raw }), { base, custom: true }, raw);
    }
  });

  test("lo demás: exit 2 con el texto", () => {
    for (const raw of [
      "http://api.ejemplo.com",
      "ftp://localhost",
      "https://api.ejemplo.com/v1",
      "https://api.ejemplo.com?x=1",
      "https://api.ejemplo.com?",
      "https://api.ejemplo.com#",
      "https://usuario:clave@api.ejemplo.com",
      "api.ejemplo.com",
      "no es una url",
    ]) {
      assert.throws(
        () => resolveApiBase({ RAYA_API_BASE: raw }),
        (error: unknown) =>
          error instanceof UsageError &&
          error.message === "RAYA_API_BASE tiene que ser https (o http://localhost para pruebas).",
        raw,
      );
    }
  });
});

describe("el detalle de un error de red", () => {
  test("el código de la causa, de la primera de varias, o «error de red»", () => {
    assert.equal(
      networkDetail(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })),
      "ECONNRESET",
    );
    const both = new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })]);
    assert.equal(networkDetail(new TypeError("fetch failed", { cause: both })), "ECONNREFUSED");
    assert.equal(
      networkDetail(new TypeError("fetch failed", { cause: new AggregateError([]) })),
      "error de red",
    );
    assert.equal(networkDetail(Object.assign(new Error("x"), { code: "EAI_AGAIN" })), "EAI_AGAIN");
    assert.equal(networkDetail(null), "error de red");
  });
});
