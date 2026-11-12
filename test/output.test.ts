import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Backoff } from "../src/backoff.ts";
import { paint, sanitize, timestamp, useColor } from "../src/output.ts";

describe("colores", () => {
  const tty = { write: () => true, isTTY: true };
  const pipe = { write: () => true, isTTY: false };

  test("con una terminal sí; sin terminal, con NO_COLOR o TERM=dumb, no", () => {
    assert.equal(useColor(tty, {}), true);
    assert.equal(useColor(pipe, {}), false);
    assert.equal(useColor({ write: () => true }, {}), false);
    assert.equal(useColor(tty, { NO_COLOR: "1" }), false);
    assert.equal(useColor(tty, { NO_COLOR: "" }), true);
    assert.equal(useColor(tty, { TERM: "dumb" }), false);
  });

  test("FORCE_COLOR los fuerza (y en 0 los apaga)", () => {
    assert.equal(useColor(pipe, { FORCE_COLOR: "1" }), true);
    assert.equal(useColor(pipe, { FORCE_COLOR: "" }), true);
    assert.equal(useColor(pipe, { FORCE_COLOR: "1", NO_COLOR: "1" }), true);
    assert.equal(useColor(tty, { FORCE_COLOR: "0" }), false);
  });

  test("paint envuelve con ANSI solo si corresponde", () => {
    assert.equal(paint(tty, {}).green("ok"), "\u001b[32mok\u001b[39m");
    assert.equal(paint(tty, {}).yellow("ok"), "\u001b[33mok\u001b[39m");
    assert.equal(paint(tty, {}).red("ok"), "\u001b[31mok\u001b[39m");
    assert.equal(paint(pipe, {}).red("ok"), "ok");
  });
});

describe("timestamp y sanitize", () => {
  test("la hora local con el formato de las líneas", () => {
    assert.equal(timestamp(new Date(2026, 10, 12, 9, 5, 7)), "2026-11-12 09:05:07");
  });

  test("saca C0, DEL y C1, y deja el resto (también ñ y emojis)", () => {
    assert.equal(
      sanitize("Mi\u001b[31m tienda\u0007\r\n\u007f\u0085ñ ✓ 😀"),
      "Mi[31m tiendañ ✓ 😀",
    );
    assert.equal(sanitize("normal"), "normal");
  });
});

describe("Backoff", () => {
  test("1, 2, 4, 8, 16 y 30 s; después se queda en 30; reset vuelve a 1", () => {
    const backoff = new Backoff(() => 0.5);
    assert.deepEqual(
      Array.from({ length: 8 }, () => backoff.next()),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
    );
    backoff.reset();
    assert.equal(backoff.next(), 1000);
  });

  test("±20 % al azar", () => {
    assert.equal(new Backoff(() => 0).next(), 800);
    assert.equal(new Backoff(() => 0.999999).next(), 1200);
    const real = new Backoff().next();
    assert.ok(real >= 800 && real <= 1200);
  });
});
