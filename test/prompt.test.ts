import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readHidden, readLine } from "../src/prompt.ts";
import { FakeInput, Sink } from "./helpers.ts";

function hidden(input: FakeInput) {
  const output = new Sink(true);
  const hooks = new Set<() => void>();
  const result = readHidden({
    input,
    output,
    prompt: "Clave: ",
    onExit: (restore) => {
      hooks.add(restore);
      return () => hooks.delete(restore);
    },
  });
  return { result, output, hooks };
}

describe("readHidden (una terminal, sin eco)", () => {
  test("Enter termina; nada de lo escrito se muestra", async () => {
    const input = new FakeInput(true);
    const { result, output, hooks } = hidden(input);
    assert.equal(hooks.size, 1);
    assert.deepEqual(input.raw, [true]);
    assert.equal(input.paused, false);
    input.send("abc");
    input.send("def\r");
    assert.equal(await result, "abcdef");
    assert.equal(output.text, "Clave: \n");
    assert.deepEqual(input.raw, [true, false]);
    assert.equal(input.paused, true);
    assert.equal(hooks.size, 0);
    assert.equal(input.listenerCount("data"), 0);
  });

  test("Backspace borra; los marcadores de pegado se descartan", async () => {
    const input = new FakeInput(true);
    const { result } = hidden(input);
    input.send("\u001b[200~raya_sk_test_xx\u001b[201~");
    input.send("\u007f\bY\n");
    assert.equal(await result, "raya_sk_test_Y");
  });

  test("las secuencias de escape se descartan enteras, también partidas", async () => {
    const input = new FakeInput(true);
    const { result } = hidden(input);
    // Un marcador partido entre dos pedazos, una flecha (CSI), otra (SS3) y un Alt+x.
    input.send("ab\u001b[20");
    input.send("0~cd\u001b[D\u001bOA\u001bxe\tf\r");
    assert.equal(await result, "abcdef");
  });

  test("Ctrl+C cancela (null) y restaura la terminal", async () => {
    const input = new FakeInput(true);
    const { result } = hidden(input);
    input.send("abc\u0003def");
    assert.equal(await result, null);
    assert.deepEqual(input.raw, [true, false]);
  });

  test("Ctrl+D sin nada escrito cancela; con algo escrito, se ignora", async () => {
    const empty = new FakeInput(true);
    const first = hidden(empty);
    empty.send("\u0004");
    assert.equal(await first.result, null);
    const typed = new FakeInput(true);
    const second = hidden(typed);
    typed.send("ab\u0004c\r");
    assert.equal(await second.result, "abc");
  });

  test("si la entrada se cierra, devuelve lo escrito", async () => {
    const input = new FakeInput(true);
    const { result } = hidden(input);
    input.send("xyz");
    input.end();
    assert.equal(await result, "xyz");
  });

  test("el hook de salida restaura la terminal si el proceso termina antes", () => {
    const input = new FakeInput(true);
    const { hooks } = hidden(input);
    for (const restore of hooks) restore();
    assert.deepEqual(input.raw, [true, false]);
  });
});

describe("readLine (sin terminal)", () => {
  test("hasta el primer salto de línea, aunque la entrada siga abierta", async () => {
    const input = new FakeInput(false);
    const line = readLine(input);
    input.send("raya_sk_");
    input.send("test_abc\r\nlo que sigue");
    assert.equal(await line, "raya_sk_test_abc");
    assert.equal(input.paused, true);
    assert.equal(input.listenerCount("data"), 0);
  });

  test("hasta el final de la entrada si no hay salto de línea", async () => {
    const input = new FakeInput(false);
    const line = readLine(input);
    input.send("  clave sin enter  ");
    input.end();
    assert.equal(await line, "  clave sin enter  ");
  });

  test("un error de la entrada se propaga", async () => {
    const input = new FakeInput(false);
    const line = readLine(input);
    input.emit("error", new Error("EIO"));
    await assert.rejects(line, /EIO/);
  });
});
