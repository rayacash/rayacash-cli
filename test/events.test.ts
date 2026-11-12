import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UsageError } from "../src/args.ts";
import { checkEventBody, LISTEN_EVENT_TYPES, parseEventArgs } from "../src/events.ts";
import { evtId, sandboxEvent } from "./helpers.ts";

describe("parseEventArgs", () => {
  test("comas, repetidos y espacios", () => {
    assert.deepEqual(
      parseEventArgs(["payment.succeeded, payment.failed", "connect.order.*", "payment.failed"]),
      ["payment.succeeded", "payment.failed", "connect.order.*"],
    );
    assert.deepEqual(parseEventArgs(["*"]), ["*"]);
    assert.deepEqual(parseEventArgs(["a,,b,"]), ["a", "b"]);
  });

  test("las comillas simples que cmd.exe no saca: un par alrededor se descarta", () => {
    // En cmd.exe, -e 'payment.*' llega con las comillas (bash, zsh, fish y PowerShell las sacan).
    assert.deepEqual(parseEventArgs(["'payment.*'"]), ["payment.*"]);
    assert.deepEqual(parseEventArgs(["'payment.*,connect.order.*'"]), [
      "payment.*",
      "connect.order.*",
    ]);
    assert.deepEqual(parseEventArgs(["'payment.*','connect.order.*'", " 'payment.failed' "]), [
      "payment.*",
      "connect.order.*",
      "payment.failed",
    ]);
    // Una comilla sola no es un par: queda, y el servidor dice qué tiene de malo.
    assert.deepEqual(parseEventArgs(["'payment.*"]), ["'payment.*"]);
    assert.throws(() => parseEventArgs(["''"]), UsageError);
  });

  test("vacío → error de uso", () => {
    for (const values of [[""], [" , "], [",", ""]]) {
      assert.throws(
        () => parseEventArgs(values),
        (error: unknown) =>
          error instanceof UsageError &&
          error.message ===
            "--events no puede estar vacío: por ejemplo -e payment.succeeded,payment.failed.",
      );
    }
  });
});

describe("checkEventBody", () => {
  test("los 8 tipos de un sandbox, en el orden del catálogo", () => {
    assert.deepEqual(LISTEN_EVENT_TYPES, [
      "payment.created",
      "payment.succeeded",
      "payment.failed",
      "payment.refunded",
      "connect.order.created",
      "connect.order.succeeded",
      "connect.order.failed",
      "connect.order.refunded",
    ]);
    assert.ok(Object.isFrozen(LISTEN_EVENT_TYPES));
    for (const type of LISTEN_EVENT_TYPES) assert.ok(checkEventBody(sandboxEvent(1, type)));
  });

  test("rechaza lo que no se puede firmar", () => {
    const ok = sandboxEvent(7);
    const cases = [
      { ...ok, body: ok.body.replace('"livemode":false', '"livemode":true') },
      { ...ok, body: ok.body.replace(',"livemode":false', "") },
      { ...ok, id: evtId(8) },
      { ...ok, type: "payment.failed" },
      sandboxEvent(7, "transfer.received"),
      sandboxEvent(7, "webhook.test"),
      { ...ok, body: "[1,2]" },
      { ...ok, body: "null" },
      { ...ok, body: "{roto" },
      { ...ok, body: `﻿${ok.body}` },
      { ...ok, id: "evt_corto", body: ok.body.replace(ok.id, "evt_corto") },
    ];
    for (const event of cases) assert.equal(checkEventBody(event), false, event.body);
    assert.equal(checkEventBody(ok), true);
  });
});
