import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UsageError } from "../src/args.ts";
import { checkKey, classifyKey, maskKey, resolveKey, TEST_SECRET_KEY_RE } from "../src/keys.ts";
import { MSG } from "../src/messages.ts";
import { liveKey, testKey } from "./helpers.ts";

function usage(run: () => unknown, message: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.exitCode, 2);
    assert.equal(error.message, message);
    return true;
  });
}

describe("classifyKey", () => {
  test("cada forma", () => {
    assert.equal(classifyKey(testKey()), "test_secret");
    assert.equal(classifyKey(liveKey()), "live_secret");
    assert.equal(classifyKey("raya_sk_live_corta"), "live_secret");
    assert.equal(classifyKey(`raya_pk_test_${"c".repeat(48)}`), "publishable");
    assert.equal(classifyKey(`raya_pk_live_${"c".repeat(48)}`), "publishable");
    assert.equal(classifyKey(`raya_at_test_${"d".repeat(48)}`), "other_credential");
    assert.equal(classifyKey(`raya_cs_live_${"d".repeat(48)}`), "other_credential");
    assert.equal(classifyKey(`raya_sk_test_${"e".repeat(47)}`), "invalid");
    assert.equal(classifyKey(`raya_sk_test_${"e".repeat(47)}-`), "invalid");
    assert.equal(classifyKey("whsec_algo"), "invalid");
    assert.equal(classifyKey(""), "invalid");
    assert.equal(TEST_SECRET_KEY_RE.source, "^raya_sk_test_[0-9A-Za-z]{48}$");
    assert.equal(testKey().length, 61);
  });
});

describe("checkKey", () => {
  test("una clave de prueba válida vuelve sin el espacio de alrededor", () => {
    assert.equal(checkKey(`  ${testKey()}\n`, "flag"), testKey());
  });

  test("cada fila de la tabla, con su origen", () => {
    const origins = {
      flag: "La clave de --api-key",
      env: "La clave de RAYA_SECRET_KEY",
      config: "La clave guardada",
      input: "Esa clave",
    } as const;
    for (const [source, origin] of Object.entries(origins) as [keyof typeof origins, string][]) {
      usage(() => checkKey(liveKey(), source), MSG.keyLive(origin));
      usage(() => checkKey(`raya_pk_test_${"c".repeat(48)}`, source), MSG.keyPublishable(origin));
      usage(
        () => checkKey(`raya_at_test_${"d".repeat(48)}`, source),
        MSG.keyOtherCredential(origin),
      );
      usage(
        () => checkKey(`raya_cs_test_${"d".repeat(48)}`, source),
        MSG.keyOtherCredential(origin),
      );
      usage(() => checkKey("cualquier cosa", source), MSG.keyInvalid(origin));
    }
    usage(() => checkKey("   ", "input"), "No pegaste ninguna clave.");
  });

  test("los textos exactos", () => {
    assert.equal(
      MSG.keyLive("La clave de --api-key"),
      "La clave de --api-key es de tu cuenta real (raya_sk_live_…). rayacash-cli solo escucha sandboxes: usá la clave secreta de prueba (raya_sk_test_…) de Developers › API Keys, adentro del sandbox. No la usamos ni la guardamos.",
    );
    assert.equal(
      MSG.keyPublishable("Esa clave"),
      "Esa clave es una clave pública (raya_pk_…). Usá la clave secreta de prueba (raya_sk_test_…).",
    );
    assert.equal(
      MSG.keyOtherCredential("La clave guardada"),
      "La clave guardada no es una clave secreta: usá la clave secreta de prueba (raya_sk_test_…) de Developers › API Keys, adentro del sandbox.",
    );
    assert.equal(
      MSG.keyInvalid("La clave de RAYA_SECRET_KEY"),
      "La clave de RAYA_SECRET_KEY no parece una clave secreta de prueba: empieza con raya_sk_test_ y tiene 61 caracteres.",
    );
    assert.equal(
      MSG.keyMissing("rayacash"),
      "Falta la clave secreta de prueba de tu sandbox (raya_sk_test_…). Guardala con rayacash login, pasala con --api-key o definí RAYA_SECRET_KEY.",
    );
  });
});

describe("maskKey", () => {
  test("el prefijo y los últimos 4, nunca la clave entera", () => {
    const key = `raya_sk_test_${"x".repeat(44)}AbCd`;
    assert.equal(maskKey(key), "raya_sk_test_…AbCd");
    assert.equal(maskKey(liveKey()), "raya_sk_live_…bbbb");
    assert.equal(maskKey("raya_sk_test_abc"), "raya_sk_test_…");
    assert.equal(maskKey("corta"), "…");
    assert.equal(maskKey("sinprefijo123456789"), "…6789");
  });
});

describe("resolveKey", () => {
  const base = { env: {}, saved: undefined, cmd: "rayacash" };

  test("precedencia: --api-key > RAYA_SECRET_KEY > la guardada", () => {
    const warn = () => assert.fail("sin avisos");
    const flag = testKey("f");
    const env = testKey("e");
    const saved = testKey("s");
    assert.deepEqual(resolveKey({ ...base, flag, env: { RAYA_SECRET_KEY: env }, saved, warn }), {
      key: flag,
      source: "flag",
    });
    assert.deepEqual(
      resolveKey({ ...base, flag: undefined, env: { RAYA_SECRET_KEY: ` ${env} ` }, saved, warn }),
      { key: env, source: "env" },
    );
    assert.deepEqual(resolveKey({ ...base, flag: undefined, saved, warn }), {
      key: saved,
      source: "config",
    });
    // Vacía cuenta como no definida.
    assert.deepEqual(
      resolveKey({ ...base, flag: undefined, env: { RAYA_SECRET_KEY: "  " }, saved, warn }),
      { key: saved, source: "config" },
    );
  });

  test("una fuente inválida es un error: nunca se cae a la siguiente", () => {
    const warn = () => assert.fail("sin avisos");
    usage(
      () => resolveKey({ ...base, flag: "mala", saved: testKey(), warn }),
      MSG.keyInvalid("La clave de --api-key"),
    );
    usage(
      () =>
        resolveKey({
          ...base,
          flag: undefined,
          env: { RAYA_SECRET_KEY: `raya_pk_test_${"c".repeat(48)}` },
          saved: testKey(),
          warn,
        }),
      MSG.keyPublishable("La clave de RAYA_SECRET_KEY"),
    );
    usage(
      () => resolveKey({ ...base, flag: undefined, saved: liveKey(), warn }),
      MSG.keyLive("La clave guardada"),
    );
    usage(
      () => resolveKey({ ...base, flag: undefined, saved: 12345, warn }),
      MSG.keyInvalid("La clave guardada"),
    );
    usage(
      () => resolveKey({ ...base, flag: liveKey(), warn }),
      MSG.keyLive("La clave de --api-key"),
    );
  });

  test("la clave real en RAYA_SECRET_KEY se ignora con un aviso y sigue con la guardada", () => {
    const warnings: string[] = [];
    const saved = testKey("s");
    const resolved = resolveKey({
      ...base,
      flag: undefined,
      env: { RAYA_SECRET_KEY: liveKey() },
      saved,
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(resolved, { key: saved, source: "config" });
    assert.deepEqual(warnings, [
      "RAYA_SECRET_KEY tiene una clave de tu cuenta real (raya_sk_live_…): rayacash-cli la ignora y no la manda a ningún lado.",
    ]);
  });

  test("la clave real en RAYA_SECRET_KEY sin una guardada: el aviso y «Falta…»", () => {
    const warnings: string[] = [];
    usage(
      () =>
        resolveKey({
          ...base,
          flag: undefined,
          env: { RAYA_SECRET_KEY: liveKey() },
          saved: null,
          cmd: "npx rayacash-cli",
          warn: (message) => warnings.push(message),
        }),
      MSG.keyMissing("npx rayacash-cli"),
    );
    assert.equal(warnings.length, 1);
  });
});
