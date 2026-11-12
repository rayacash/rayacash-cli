import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { ListenPage, PollOptions } from "../src/api.ts";
import { configPath, readConfig, writeConfig } from "../src/config.ts";
import { main } from "../src/main.ts";
import { HELP, MSG, npmLogsDir } from "../src/messages.ts";
import { ALL_EVENTS, SANDBOX } from "./fake-api.ts";
import { type FakeIo, fakeIo, liveKey, testKey } from "./helpers.ts";

const posix = process.platform !== "win32";

function fileOf(fake: FakeIo): string {
  return configPath(fake.io.env, fake.io.platform, fake.io.homedir());
}

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

/** Una API falsa que responde `pages` y después «aprieta Ctrl+C». */
function scripted(pages: ListenPage[]) {
  const polls: PollOptions[] = [];
  let fake: FakeIo | undefined;
  const api = async (poll: PollOptions) => {
    polls.push(poll);
    const next = pages.shift();
    if (next) return next;
    for (const handler of fake?.signals ?? []) handler();
    throw new Error("fin");
  };
  return {
    polls,
    bind: (bound: FakeIo) => {
      fake = bound;
      return bound;
    },
    api,
  };
}

describe("main", () => {
  test("Node viejo: el mensaje y exit 1", async () => {
    const fake = fakeIo();
    fake.io.nodeVersion = "20.11.1";
    assert.equal(await main(["listen"], fake.io), 1);
    assert.equal(
      fake.stderr.text,
      "rayacash-cli necesita Node.js 22 o más nuevo (tenés 20.11.1).\n",
    );
  });

  test("--help y --version a stdout", async () => {
    const fake = fakeIo();
    assert.equal(await main(["--version"], fake.io), 0);
    assert.equal(await main([], fake.io), 0);
    assert.equal(fake.stdout.text, `rayacash-cli 1.0.0\n${HELP.main("rayacash")}`);
    const npx = fakeIo({ env: { npm_lifecycle_event: "npx" } });
    assert.equal(await main(["listen", "--help"], npx.io), 0);
    assert.equal(npx.stdout.text, HELP.listen("npx rayacash-cli"));
  });

  test("un error de uso: stderr y exit 2", async () => {
    const fake = fakeIo();
    assert.equal(await main(["listen", "--nada"], fake.io), 2);
    assert.equal(fake.stderr.text, "No conocemos la opción --nada. Mirá rayacash listen --help.\n");
    assert.equal(fake.stdout.text, "");
  });
});

describe("login", () => {
  test("con --api-key: la guarda (600) y no muestra la clave entera", async () => {
    const fake = fakeIo();
    const key = testKey("Q1");
    assert.equal(await main(["login", "--api-key", ` ${key} `], fake.io), 0);
    const file = fileOf(fake);
    assert.equal(
      fake.stdout.text,
      `Listo: guardamos la clave raya_sk_test_…${key.slice(-4)} en ${file}.\n`,
    );
    assert.equal(fake.stdout.text.includes(key), false);
    assert.deepEqual(readConfig(file), { api_key: key });
    if (posix) assert.equal(statSync(file).mode & 0o777, 0o600);
    // Otra: dice a cuál reemplaza. La misma: no.
    const other = testKey("W2");
    assert.equal(await main(["login", "--api-key", other], fake.io), 0);
    assert.match(
      fake.stdout.text,
      new RegExp(`\\(reemplaza a raya_sk_test_…${key.slice(-4)}\\)\\.\\n$`),
    );
    assert.equal(await main(["login", "--api-key", other], fake.io), 0);
    assert.match(fake.stdout.lines().at(-1) ?? "", /^Listo: guardamos la clave .* en .*\.$/);
    assert.equal(fake.stdout.lines().at(-1)?.includes("reemplaza"), false);
  });

  test("una clave real o inválida: exit 2 y no se guarda nada", async () => {
    const fake = fakeIo();
    assert.equal(await main(["login", "--api-key", liveKey()], fake.io), 2);
    assert.equal(fake.stderr.text, `${MSG.keyLive("Esa clave")}\n`);
    assert.equal(existsSync(fileOf(fake)), false);
    assert.equal(await main(["login", "--api-key", `raya_pk_test_${"c".repeat(48)}`], fake.io), 2);
    assert.match(fake.stderr.text, /Esa clave es una clave pública/);
  });

  test("con una terminal: el prompt en stderr, sin eco, y Enter guarda", async () => {
    const fake = fakeIo({ stdinTTY: true });
    const key = testKey("T3");
    const done = main(["login"], fake.io);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      fake.stderr.text,
      "Pegá la clave secreta de prueba de tu sandbox (raya_sk_test_…). Está en Developers › API Keys, adentro del sandbox.\nClave: ",
    );
    assert.equal(fake.exitHooks.size, 1);
    fake.stdin.send(`\u001b[200~${key}\u001b[201~`);
    fake.stdin.send("\r");
    assert.equal(await done, 0);
    assert.equal(fake.stderr.text.includes(key), false);
    assert.deepEqual(fake.stdin.raw, [true, false]);
    assert.equal(fake.exitHooks.size, 0);
    assert.deepEqual(readConfig(fileOf(fake)), { api_key: key });
  });

  test("Ctrl+C en el prompt: «Cancelado.» y 130", async () => {
    const fake = fakeIo({ stdinTTY: true });
    const done = main(["login"], fake.io);
    await new Promise((resolve) => setImmediate(resolve));
    fake.stdin.send("raya_sk\u0003");
    assert.equal(await done, 130);
    assert.match(fake.stderr.text, /Clave: \nCancelado\.\n$/);
    assert.equal(existsSync(fileOf(fake)), false);
  });

  test("sin terminal: lee hasta el primer Enter (la entrada sigue abierta)", async () => {
    const fake = fakeIo();
    const key = testKey("P4");
    const done = main(["login"], fake.io);
    fake.stdin.send(`${key}\n`);
    assert.equal(await done, 0);
    assert.equal(fake.stderr.text, "");
    assert.deepEqual(readConfig(fileOf(fake)), { api_key: key });
  });

  test("Git Bash sin terminal (MSYSTEM): avisa que se ve y que hay que apretar Enter", async () => {
    const fake = fakeIo({ env: { MSYSTEM: "MINGW64" } });
    const done = main(["login"], fake.io);
    fake.stdin.send(`${testKey()}\r\n`);
    assert.equal(await done, 0);
    assert.equal(
      fake.stderr.text,
      "Esta terminal no oculta lo que escribís: la clave se va a ver. Si preferís, usá rayacash login --api-key … o RAYA_SECRET_KEY.\nPegá la clave y apretá Enter.\n",
    );
  });

  test("sin nada: «No pegaste ninguna clave.» y exit 2", async () => {
    const fake = fakeIo();
    const done = main(["login"], fake.io);
    fake.stdin.end();
    assert.equal(await done, 2);
    assert.equal(fake.stderr.text, "No pegaste ninguna clave.\n");
  });

  test("una configuración rota: exit 1 con el texto", async () => {
    const fake = fakeIo();
    const file = fileOf(fake);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{roto");
    assert.equal(await main(["login", "--api-key", testKey()], fake.io), 1);
    assert.equal(fake.stderr.text, `${MSG.configBroken(file, "rayacash")}\n`);
  });
});

describe("logout", () => {
  test("borra la clave y conserva el secreto y lo demás", async () => {
    const fake = fakeIo();
    const file = fileOf(fake);
    const key = testKey("L5");
    writeConfig(file, { api_key: key, webhook_secret: "whsec_abcdefghijk", otra: true });
    assert.equal(await main(["logout"], fake.io), 0);
    assert.equal(
      fake.stdout.text,
      `Listo: borramos la clave raya_sk_test_…${key.slice(-4)} de esta máquina. El secreto de firma no cambia.\n`,
    );
    assert.deepEqual(readConfig(file), { webhook_secret: "whsec_abcdefghijk", otra: true });
    assert.equal(await main(["logout"], fake.io), 0);
    assert.match(fake.stdout.text, /No había ninguna clave guardada\.\n$/);
  });

  test("sin configuración: no crea nada", async () => {
    const fake = fakeIo();
    assert.equal(await main(["logout"], fake.io), 0);
    assert.equal(fake.stdout.text, "No había ninguna clave guardada.\n");
    assert.equal(existsSync(fileOf(fake)), false);
  });
});

describe("listen", () => {
  test("--print-secret: solo el secreto en stdout, siempre el mismo, sin clave ni red", async () => {
    const fake = fakeIo({
      api: async () => assert.fail("--print-secret no sale a la red"),
    });
    assert.equal(await main(["listen", "--print-secret"], fake.io), 0);
    assert.equal(await main(["listen", "--print-secret"], fake.io), 0);
    const [first, second] = fake.stdout.text.split("\n");
    assert.match(first ?? "", /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.equal(second, first);
    assert.equal(fake.stdout.text, `${first}\n${first}\n`);
    assert.equal(fake.stderr.text, "");
    if (posix) assert.equal(statSync(fileOf(fake)).mode & 0o777, 0o600);
  });

  test("con permisos de más, el aviso va a stderr (stdout sigue limpio)", {
    skip: !posix,
  }, async () => {
    const fake = fakeIo();
    const file = fileOf(fake);
    writeConfig(file, { webhook_secret: "whsec_existenteYfijo" });
    chmodSync(file, 0o644);
    assert.equal(await main(["listen", "--print-secret"], fake.io), 0);
    assert.equal(fake.stdout.text, "whsec_existenteYfijo\n");
    assert.equal(fake.stderr.text, `${MSG.configInsecure(file)}\n`);
  });

  test("arranca con la clave guardada y escucha todo por defecto", async () => {
    const script = scripted([pg()]);
    const fake = script.bind(fakeIo({ api: script.api }));
    writeConfig(fileOf(fake), { api_key: testKey("S6") });
    assert.equal(await main(["listen"], fake.io), 0);
    assert.equal(script.polls[0]?.apiBase, "https://api.raya.cash");
    assert.equal(script.polls[0]?.apiKey, testKey("S6"));
    assert.deepEqual(script.polls[0]?.events, ["*"]);
    const secret = String(readConfig(fileOf(fake)).webhook_secret);
    assert.match(secret, /^whsec_/);
    assert.ok(fake.stderr.text.includes(`Secreto de firma: ${secret}  (en tu servidor`));
    assert.match(fake.stderr.text, /Sin --forward-to: solo mostramos los eventos\./);
  });

  test("--api-key: el aviso de la lista de procesos; -e y -f llegan normalizados", async () => {
    const script = scripted([pg()]);
    const fake = script.bind(
      fakeIo({ api: script.api, env: { RAYA_API_BASE: "http://127.0.0.1:8" } }),
    );
    const key = testKey("K7");
    const code = await main(
      [
        "listen",
        "--api-key",
        key,
        "-e",
        "payment.*,connect.order.succeeded",
        "-e",
        "payment.*",
        "-f",
        ":3000/webhooks/raya",
      ],
      fake.io,
    );
    assert.equal(code, 0);
    assert.deepEqual(fake.stderr.lines().slice(0, 2), [
      "Usando la API en http://127.0.0.1:8 (RAYA_API_BASE).",
      "Con --api-key la clave queda visible en la lista de procesos mientras escuchás: mejor guardala con rayacash login o usá RAYA_SECRET_KEY.",
    ]);
    assert.equal(script.polls[0]?.apiBase, "http://127.0.0.1:8");
    assert.equal(script.polls[0]?.apiKey, key);
    assert.deepEqual(script.polls[0]?.events, ["payment.*", "connect.order.succeeded"]);
    assert.match(fake.stderr.text, /^Reenviando a http:\/\/localhost:3000\/webhooks\/raya$/m);
  });

  test("RAYA_SECRET_KEY con una clave real: se ignora con un aviso y sigue con la guardada", async () => {
    const script = scripted([pg()]);
    const fake = script.bind(fakeIo({ api: script.api, env: { RAYA_SECRET_KEY: liveKey() } }));
    writeConfig(fileOf(fake), { api_key: testKey("G8") });
    assert.equal(await main(["listen"], fake.io), 0);
    assert.equal(fake.stderr.lines()[0], MSG.envLiveIgnored);
    assert.equal(script.polls[0]?.apiKey, testKey("G8"));
    assert.equal(fake.stderr.text.includes(liveKey()), false);
  });

  test("errores antes de la red: exit 2 y la API ni se llama", async () => {
    const cases: [string[], Record<string, string>, string][] = [
      [["listen"], {}, MSG.keyMissing("rayacash")],
      [["listen"], { npm_lifecycle_event: "npx" }, MSG.keyMissing("npx rayacash-cli")],
      [["listen", "--api-key", liveKey()], {}, MSG.keyLive("La clave de --api-key")],
      [["listen"], { RAYA_API_BASE: "http://api.ejemplo.com" }, MSG.apiBaseInvalid],
      [["listen", "--api-key", testKey(), "-f", "ftp://x"], {}, MSG.forwardScheme],
      [["listen", "--api-key", testKey(), "-e", " , "], {}, MSG.eventsEmpty],
    ];
    for (const [argv, env, message] of cases) {
      const fake = fakeIo({ env, api: async () => assert.fail("no sale a la red") });
      assert.equal(await main(argv, fake.io), 2, message);
      assert.equal(fake.stderr.lines().at(-1), message);
    }
  });

  test("la configuración con permisos de más: el aviso al arrancar", { skip: !posix }, async () => {
    const script = scripted([pg()]);
    const fake = script.bind(fakeIo({ api: script.api }));
    const file = fileOf(fake);
    writeConfig(file, { api_key: testKey() });
    chmodSync(file, 0o604);
    assert.equal(await main(["listen"], fake.io), 0);
    assert.equal(fake.stderr.lines()[0], MSG.configInsecure(file));
  });

  test("un error inesperado: el detalle y exit 1", async () => {
    const fake = fakeIo({
      api: async () => {
        throw new TypeError("se rompió algo");
      },
    });
    writeConfig(fileOf(fake), { api_key: testKey() });
    assert.equal(await main(["listen"], fake.io), 1);
    assert.equal(
      fake.stderr.lines().at(-1),
      "rayacash-cli falló: se rompió algo. Si sigue, escribinos a soporte@raya.cash.",
    );
    const odd = fakeIo({
      api: async () => {
        throw "un string";
      },
    });
    writeConfig(fileOf(odd), { api_key: testKey() });
    assert.equal(await main(["listen"], odd.io), 1);
    assert.match(odd.stderr.text, /rayacash-cli falló: un string\./);
  });

  test("Windows: la configuración en %APPDATA% (solo se lee: en POSIX no es una ruta real)", async () => {
    const fake = fakeIo({ platform: "win32" });
    fake.io.env.APPDATA = "C:\\Users\\ana\\AppData\\Roaming";
    assert.equal(fileOf(fake), "C:\\Users\\ana\\AppData\\Roaming\\rayacash\\config.json");
    if (process.platform === "win32") return;
    assert.equal(await main(["logout"], fake.io), 0);
    assert.equal(fake.stdout.text, "No había ninguna clave guardada.\n");
    assert.equal(existsSync(fileOf(fake)), false);
  });

  test("NODE_TLS_REJECT_UNAUTHORIZED=0: avisa y la conexión con la API se verifica igual", async () => {
    let atPoll: string | undefined = "sin sondear";
    const script = scripted([pg()]);
    const fake = script.bind(
      fakeIo({
        env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        api: (poll) => {
          atPoll = fake.io.env.NODE_TLS_REJECT_UNAUTHORIZED;
          return script.api(poll);
        },
      }),
    );
    writeConfig(fileOf(fake), { api_key: testKey() });
    assert.equal(await main(["listen"], fake.io), 0);
    // Antes del primer sondeo: sin la variable, Node verifica el certificado de la API.
    assert.equal(atPoll, undefined);
    assert.equal(fake.stderr.lines()[0], MSG.tlsRejectIgnored);
    assert.equal(
      MSG.tlsRejectIgnored,
      "Tenés NODE_TLS_REJECT_UNAUTHORIZED=0: rayacash-cli la ignora y verifica igual el certificado de la API de Raya Cash, porque tu clave viaja ahí.",
    );
    // Con otro valor, nada.
    const other = scripted([pg()]);
    const quiet = other.bind(
      fakeIo({ api: other.api, env: { NODE_TLS_REJECT_UNAUTHORIZED: "1" } }),
    );
    writeConfig(fileOf(quiet), { api_key: testKey() });
    assert.equal(await main(["listen"], quiet.io), 0);
    assert.equal(quiet.stderr.text.includes("NODE_TLS_REJECT_UNAUTHORIZED"), false);
    assert.equal(quiet.io.env.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  });
});

describe("npx y --api-key: npm anota el comando en sus logs", () => {
  const npx = { npm_lifecycle_event: "npx", npm_config_cache: "/home/ana/.npm" };
  const LOGS = "/home/ana/.npm/_logs";

  test("listen: además del aviso de la lista de procesos, el de los logs de npm", async () => {
    const script = scripted([pg()]);
    const fake = script.bind(fakeIo({ api: script.api, env: npx }));
    assert.equal(await main(["listen", "--api-key", testKey("N1")], fake.io), 0);
    assert.deepEqual(fake.stderr.lines().slice(0, 2), [
      MSG.apiKeyVisible("npx rayacash-cli"),
      `Con npx, npm anota el comando, con la clave, en sus logs (${LOGS}): usá RAYA_SECRET_KEY o npx rayacash-cli login.`,
    ]);
    // Sin npx (instalado), solo el de la lista de procesos.
    const installed = scripted([pg()]);
    const plain = installed.bind(fakeIo({ api: installed.api }));
    assert.equal(await main(["listen", "--api-key", testKey("N1")], plain.io), 0);
    assert.equal(plain.stderr.text.includes("npm anota"), false);
  });

  test("una clave real por --api-key con npx: no la usamos, pero npm la anotó", async () => {
    const fake = fakeIo({ env: npx, api: async () => assert.fail("no sale a la red") });
    assert.equal(await main(["listen", "--api-key", liveKey()], fake.io), 2);
    const message = MSG.keyLive("La clave de --api-key", LOGS);
    assert.equal(fake.stderr.lines().at(-1), message);
    assert.match(
      message,
      /No la usamos, pero npm la anotó en sus logs \(\/home\/ana\/\.npm\/_logs\): borrá esos logs y rotá la clave\.$/,
    );
    assert.equal(fake.stderr.text.includes(liveKey()), false);
    const login = fakeIo({ env: npx });
    assert.equal(await main(["login", "--api-key", liveKey()], login.io), 2);
    assert.equal(login.stderr.text, `${MSG.keyLive("Esa clave", LOGS)}\n`);
  });

  test("login --api-key con npx: la guarda y avisa de los logs", async () => {
    const fake = fakeIo({ env: npx });
    const key = testKey("N2");
    assert.equal(await main(["login", "--api-key", key], fake.io), 0);
    assert.deepEqual(readConfig(fileOf(fake)), { api_key: key });
    assert.equal(fake.stderr.text, `${MSG.apiKeyNpmLogged(LOGS, "npx rayacash-cli")}\n`);
  });

  test("dónde quedan los logs: npm_config_logs_dir, la cache de npm o el default", () => {
    assert.equal(npmLogsDir({ npm_lifecycle_event: "npx" }, "linux"), "~/.npm/_logs");
    assert.equal(
      npmLogsDir({ npm_lifecycle_event: "npx" }, "win32"),
      "%LocalAppData%\\npm-cache\\_logs",
    );
    assert.equal(
      npmLogsDir({ npm_lifecycle_event: "npx", npm_config_cache: "C:\\cache" }, "win32"),
      "C:\\cache\\_logs",
    );
    assert.equal(
      npmLogsDir({ npm_lifecycle_event: "npx", npm_config_logs_dir: "/var/log/npm" }, "darwin"),
      "/var/log/npm",
    );
    // Sin npx, npm no anotó nada.
    assert.equal(npmLogsDir({}, "linux"), null);
    assert.equal(npmLogsDir({ npm_lifecycle_event: "test" }, "linux"), null);
  });
});

describe("login con RAYA_SECRET_KEY definida", () => {
  test("avisa que listen va a usar la de RAYA_SECRET_KEY (si es otra)", async () => {
    const other = testKey("E1");
    const fake = fakeIo({ env: { RAYA_SECRET_KEY: ` ${other} ` } });
    assert.equal(await main(["login", "--api-key", testKey("Q1")], fake.io), 0);
    assert.equal(
      fake.stderr.text,
      `${MSG.envKeyWins(`raya_sk_test_…${other.slice(-4)}`, "rayacash")}\n`,
    );
    assert.equal(
      MSG.envKeyWins("raya_sk_test_…E1E1", "rayacash"),
      "RAYA_SECRET_KEY está definida en esta terminal (raya_sk_test_…E1E1) y tiene prioridad sobre la clave guardada: rayacash listen va a usar esa.",
    );
    assert.equal(fake.stderr.text.includes(other), false);
    // La misma clave, una de la cuenta real (listen la ignora) o vacía: nada.
    for (const value of [testKey("Q1"), liveKey(), "  "]) {
      const quiet = fakeIo({ env: { RAYA_SECRET_KEY: value } });
      assert.equal(await main(["login", "--api-key", testKey("Q1")], quiet.io), 0);
      assert.equal(quiet.stderr.text, "", value);
    }
  });
});
