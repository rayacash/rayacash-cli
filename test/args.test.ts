import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Command, type ParseContext, parseCommandLine, UsageError } from "../src/args.ts";
import { cmdName, HELP, MSG } from "../src/messages.ts";
import { liveKey, testKey } from "./helpers.ts";

const ctx: ParseContext = { cmd: "rayacash", exists: () => false };

function parse(argv: string[], over: Partial<typeof ctx> = {}): Command {
  return parseCommandLine(argv, { ...ctx, ...over });
}

function usage(argv: string[], message: string, over: Partial<typeof ctx> = {}): void {
  assert.throws(
    () => parse(argv, over),
    (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.exitCode, 2);
      assert.equal(error.message, message);
      return true;
    },
  );
}

const listenDefaults = {
  kind: "listen",
  apiKey: undefined,
  forwardTo: undefined,
  events: [],
  printSecret: false,
  json: false,
  skipVerify: false,
};

describe("el comando", () => {
  test("sin argumentos, help, -h y --help: la ayuda general", () => {
    for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
      assert.deepEqual(parse(argv), { kind: "help", text: HELP.main("rayacash") });
    }
  });

  test("-v y --version", () => {
    assert.deepEqual(parse(["-v"]), { kind: "version" });
    assert.deepEqual(parse(["--version"]), { kind: "version" });
    assert.equal(MSG.version, "rayacash-cli 1.0.0");
  });

  test("help <comando> y <comando> --help", () => {
    for (const command of ["listen", "login", "logout"] as const) {
      const text = HELP[command]("rayacash");
      assert.deepEqual(parse(["help", command]), { kind: "help", text });
      assert.deepEqual(parse([command, "--help"]), { kind: "help", text });
      assert.deepEqual(parse([command, "-h"]), { kind: "help", text });
    }
    // --help gana aunque haya una opción mal escrita.
    assert.deepEqual(parse(["listen", "--forwrd", "x", "--help"]), {
      kind: "help",
      text: HELP.listen("rayacash"),
    });
  });

  test("comando y opción global desconocidos", () => {
    usage(
      ["escuchar"],
      "No conocemos el comando «escuchar». Los comandos son login, listen y logout (rayacash --help).",
    );
    usage(
      ["help", "escuchar"],
      "No conocemos el comando «escuchar». Los comandos son login, listen y logout (rayacash --help).",
    );
    usage(["--api-key=x", "listen"], "No conocemos la opción --api-key. Mirá rayacash --help.");
    usage(["-x"], "No conocemos la opción -x. Mirá rayacash --help.");
    // Un texto con controles no llega a la terminal.
    usage(
      ["a\u001b[2Jb"],
      "No conocemos el comando «a[2Jb». Los comandos son login, listen y logout (rayacash --help).",
    );
  });
});

describe("listen", () => {
  test("sin opciones", () => {
    assert.deepEqual(parse(["listen"]), listenDefaults);
  });

  test("todas las opciones, cortas y largas", () => {
    assert.deepEqual(
      parse([
        "listen",
        "-f",
        "localhost:3000/webhooks/raya",
        "-e",
        "payment.succeeded,payment.failed",
        "--events=connect.order.*",
        "--api-key",
        "raya_sk_test_x",
        "--json",
        "--skip-verify",
      ]),
      {
        ...listenDefaults,
        apiKey: "raya_sk_test_x",
        forwardTo: "localhost:3000/webhooks/raya",
        events: ["payment.succeeded,payment.failed", "connect.order.*"],
        json: true,
        skipVerify: true,
      },
    );
    assert.deepEqual(parse(["listen", "--forward-to=http://x/y"]), {
      ...listenDefaults,
      forwardTo: "http://x/y",
    });
  });

  test("--print-secret va solo", () => {
    assert.deepEqual(parse(["listen", "--print-secret"]), { ...listenDefaults, printSecret: true });
    for (const extra of [["--json"], ["-f", "3000"], ["-e", "*"], ["--api-key", "x"]]) {
      usage(
        ["listen", "--print-secret", ...extra],
        "--print-secret va solo: rayacash listen --print-secret.",
      );
    }
  });

  test("opción desconocida, valor que falta y valor que sobra", () => {
    usage(
      ["listen", "--forwrd-to", "x"],
      "No conocemos la opción --forwrd-to. Mirá rayacash listen --help.",
    );
    usage(["listen", "-x"], "No conocemos la opción -x. Mirá rayacash listen --help.");
    usage(["listen", "-f"], "Falta el valor de --forward-to.");
    usage(["listen", "--api-key"], "Falta el valor de --api-key.");
    usage(["listen", "-f", "-e", "x"], "Falta el valor de --forward-to.");
    usage(["listen", "-e"], "Falta el valor de --events.");
    usage(["listen", "--json=1"], "--json no lleva valor.");
    // Un valor que empieza con guion, explícito con =, vale.
    assert.equal((parse(["listen", "--api-key=-x"]) as { apiKey: string }).apiKey, "-x");
  });

  test("lo que sobra", () => {
    usage(["listen", "extra"], "Sobra «extra». Mirá rayacash listen --help.");
    usage(["listen", "--", "--json"], "Sobra «--json». Mirá rayacash listen --help.");
    usage(["listen", "-f", "3000", "extra"], "Sobra «extra». Mirá rayacash listen --help.");
  });

  test("-e 'payment.*' sin comillas: la pista, antes de la red", () => {
    const hint =
      "¿Escribiste payment.* sin comillas? La terminal lo cambió por nombres de archivos: usá -e 'payment.*'.";
    assert.equal(MSG.unquotedPattern, hint);
    // bash con dos archivos que coinciden: el segundo sobra después de -e.
    usage(["listen", "-e", "payment.controller.ts", "payment.service.ts"], hint);
    // Un solo archivo: llega su nombre, y existe.
    const exists = (name: string) => name === "payment.ts";
    usage(["listen", "-e", "payment.ts"], hint, { exists });
    usage(["listen", "-e", "payment.succeeded, payment.ts"], hint, { exists });
    // Con comillas, o un tipo que no es un archivo, pasa.
    assert.deepEqual(
      (parse(["listen", "-e", "payment.*"], { exists }) as { events: string[] }).events,
      ["payment.*"],
    );
  });
});

describe("login y logout", () => {
  test("login con y sin --api-key", () => {
    assert.deepEqual(parse(["login"]), { kind: "login", apiKey: undefined });
    assert.deepEqual(parse(["login", "--api-key", "k"]), { kind: "login", apiKey: "k" });
    usage(["login", "k"], "Sobra «k». Mirá rayacash login --help.");
    usage(["login", "--json"], "No conocemos la opción --json. Mirá rayacash login --help.");
  });

  test("logout no lleva nada", () => {
    assert.deepEqual(parse(["logout"]), { kind: "logout" });
    usage(
      ["logout", "--api-key", "x"],
      "No conocemos la opción --api-key. Mirá rayacash logout --help.",
    );
    usage(["logout", "ya"], "Sobra «ya». Mirá rayacash logout --help.");
  });

  test("una clave pegada como argumento: nunca se muestra entera", () => {
    const key = testKey("Pp1");
    const live = liveKey();
    const shown = (value: string) => `${value.slice(0, 13)}…${value.slice(-4)}`;
    const cases: [string[], string][] = [
      [
        ["login", key],
        `Sobra la clave ${shown(key)}: pasala con --api-key o pegala cuando rayacash login te la pide.`,
      ],
      [
        ["login", live],
        `Sobra la clave ${shown(live)}: pasala con --api-key o pegala cuando rayacash login te la pide.`,
      ],
      [
        ["listen", live],
        `Sobra la clave ${shown(live)}: pasala con --api-key o usá RAYA_SECRET_KEY. Mirá rayacash listen --help.`,
      ],
      [["logout", key], `Sobra «${shown(key)}». Mirá rayacash logout --help.`],
      [
        [live],
        `No conocemos el comando «${shown(live)}». Los comandos son login, listen y logout (rayacash --help).`,
      ],
      [
        ["help", key],
        `No conocemos el comando «${shown(key)}». Los comandos son login, listen y logout (rayacash --help).`,
      ],
      // Otras credenciales de Raya y una corta: tampoco enteras.
      [
        ["listen", `raya_pk_test_${"c".repeat(48)}`],
        "Sobra la clave raya_pk_test_…cccc: pasala con --api-key o usá RAYA_SECRET_KEY. Mirá rayacash listen --help.",
      ],
      [["logout", "raya_sk_x"], "Sobra «raya_…». Mirá rayacash logout --help."],
    ];
    for (const [argv, message] of cases) {
      usage(argv, message);
      assert.equal(message.includes(key) || message.includes(live), false);
    }
    usage(
      ["login", key],
      `Sobra la clave ${shown(key)}: pasala con --api-key o pegala cuando npx rayacash-cli login te la pide.`,
      { cmd: "npx rayacash-cli" },
    );
  });
});

describe("{cmd}", () => {
  test("npx rayacash-cli con npx; rayacash en cualquier otro caso", () => {
    assert.equal(cmdName({ npm_lifecycle_event: "npx" }), "npx rayacash-cli");
    assert.equal(cmdName({ npm_lifecycle_event: "test" }), "rayacash");
    assert.equal(cmdName({}), "rayacash");
  });

  test("los mensajes y las ayudas lo usan", () => {
    const npx = { cmd: "npx rayacash-cli" };
    usage(["listen", "-x"], "No conocemos la opción -x. Mirá npx rayacash-cli listen --help.", npx);
    usage(
      ["nada"],
      "No conocemos el comando «nada». Los comandos son login, listen y logout (npx rayacash-cli --help).",
      npx,
    );
    usage(
      ["listen", "--print-secret", "--json"],
      "--print-secret va solo: npx rayacash-cli listen --print-secret.",
      npx,
    );
    assert.match(HELP.main("npx rayacash-cli"), /^ {2}npx rayacash-cli <comando> \[opciones\]$/m);
    assert.match(HELP.main("npx rayacash-cli"), /^Más ayuda: npx rayacash-cli <comando> --help$/m);
    assert.match(HELP.listen("npx rayacash-cli"), /con npx rayacash-cli login\./);
    assert.match(HELP.logout("npx rayacash-cli"), /^npx rayacash-cli login\. El secreto/m);
    assert.match(
      HELP.login("npx rayacash-cli"),
      /^Uso: npx rayacash-cli login \[--api-key <clave>\]$/m,
    );
  });
});

describe("las ayudas", () => {
  test("los textos exactos", () => {
    assert.equal(
      HELP.main("rayacash"),
      `rayacash-cli 1.0.0 · Escuchá en tu máquina los webhooks de tu sandbox de Raya Cash

Uso:
  rayacash <comando> [opciones]

Comandos:
  login     Guarda en esta máquina la clave secreta de prueba de tu sandbox
  listen    Escucha los eventos del sandbox y los reenvía a tu servidor local
  logout    Borra la clave guardada

Opciones:
  -h, --help       Muestra esta ayuda
  -v, --version    Muestra la versión

Más ayuda: rayacash <comando> --help
`,
    );
    assert.equal(
      HELP.login("rayacash"),
      `Uso: rayacash login [--api-key <clave>]

Guarda en esta máquina la clave secreta de prueba de tu sandbox
(raya_sk_test_…), en un archivo que solo tu usuario puede leer. La encontrás
en Developers › API Keys, adentro del sandbox. Sin --api-key, te la pedimos
sin mostrarla.
`,
    );
    assert.equal(
      HELP.logout("rayacash"),
      `Uso: rayacash logout

Borra de esta máquina la clave que guardaste con
rayacash login. El secreto de firma no cambia.
`,
    );
  });

  test("la de listen: cada opción, los 8 eventos y los patrones entre comillas", () => {
    const text = HELP.listen("rayacash");
    for (const option of [
      "-f, --forward-to <url>",
      "-e, --events <tipos>",
      "--api-key <clave>",
      "--print-secret",
      "--json",
      "--skip-verify",
      "-h, --help",
    ]) {
      assert.ok(text.includes(option), option);
    }
    assert.match(text, /^Uso: rayacash listen \[opciones\]$/m);
    assert.match(text, /abrila antes de simular\.$/m);
    assert.match(text, /También 'payment\.\*' y\n\s+'connect\.order\.\*', entre comillas\./);
    assert.match(text, /^ {2}rayacash listen -e 'payment\.\*' -f localhost:3000\/webhooks\/raya$/m);
    // Ningún * sin comillas.
    assert.doesNotMatch(text.replace(/'[^']*'/g, ""), /\*/);
    // Ninguna línea de más de 80 columnas.
    for (const line of text.split("\n")) assert.ok(line.length <= 80, line);
  });
});
