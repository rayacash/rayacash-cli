import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { sign, signatureHeader } from "../src/signature.ts";

// Los vectores públicos de la firma (los mismos de la referencia de la API y de los SDKs).
const BODY = Buffer.from('{"id":"evt_test","object":"event","type":"webhook.test"}', "utf8");

describe("firma", () => {
  test("los dos vectores públicos", () => {
    assert.equal(
      sign("whsec_test_5f2b8c1e", 1700000000, BODY),
      "2d8099cd1fe615acd8a181903c2478d2526fc47c784558a9c4e512619c4e60d8",
    );
    assert.equal(
      sign("whsec_old_0a9d", 1700000000, BODY),
      "8e449e40286c1e331a636dd9e38ab4a548c3c9a09733fa05205d7a10623ecc45",
    );
  });

  test("el header lleva t y un solo v1", () => {
    assert.equal(
      signatureHeader("whsec_test_5f2b8c1e", 1700000000, BODY),
      "t=1700000000,v1=2d8099cd1fe615acd8a181903c2478d2526fc47c784558a9c4e512619c4e60d8",
    );
  });

  test("firma los bytes UTF-8 exactos (ñ, — y ✓) con el secreto entero", () => {
    const body = Buffer.from('{"description":"Pedido ñandú — ✓"}', "utf8");
    const expected = createHmac("sha256", "whsec_abc")
      .update(Buffer.concat([Buffer.from("1700000001.", "ascii"), body]))
      .digest("hex");
    assert.equal(sign("whsec_abc", 1700000001, body), expected);
    assert.match(sign("whsec_abc", 1700000001, body), /^[0-9a-f]{64}$/);
    // Otro byte, otra firma.
    assert.notEqual(sign("whsec_abc", 1700000001, Buffer.from(`${body} `)), expected);
  });
});
