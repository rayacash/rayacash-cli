// Los argumentos, en dos pasos: primero el comando y después sus opciones. parseArgs corre sin
// strict y con tokens: la validación es nuestra, con los mensajes en castellano (los de Node vienen
// en inglés y cambian entre versiones).
import { parseArgs } from "node:util";
import { HELP, MSG } from "./messages.js";
import { sanitize } from "./output.js";
/** Un error que termina el comando con su mensaje (stderr) y su código de salida. */
export class CliError extends Error {
    exitCode;
    constructor(message, exitCode) {
        super(message);
        this.name = "CliError";
        this.exitCode = exitCode;
    }
}
/** Un error de uso: opción, comando, clave, URL o eventos inválidos (exit 2). */
export class UsageError extends CliError {
    constructor(message) {
        super(message, 2);
        this.name = "UsageError";
    }
}
const HELP_OPTION = { type: "boolean", short: "h" };
const OPTIONS = {
    listen: {
        "forward-to": { type: "string", short: "f" },
        events: { type: "string", short: "e", multiple: true },
        "api-key": { type: "string" },
        "print-secret": { type: "boolean" },
        json: { type: "boolean" },
        "skip-verify": { type: "boolean" },
        help: HELP_OPTION,
    },
    login: { "api-key": { type: "string" }, help: HELP_OPTION },
    logout: { help: HELP_OPTION },
};
const HELP_TEXT = { listen: HELP.listen, login: HELP.login, logout: HELP.logout };
export function parseCommandLine(argv, ctx) {
    const first = argv[0];
    if (first === undefined || first === "-h" || first === "--help") {
        return { kind: "help", text: HELP.main(ctx.cmd) };
    }
    if (first === "-v" || first === "--version")
        return { kind: "version" };
    if (first.startsWith("-")) {
        throw new UsageError(MSG.unknownOption(sanitize(first.split("=")[0] ?? first), ctx.cmd, null));
    }
    const rest = argv.slice(1);
    if (first === "help")
        return helpFor(rest[0], ctx);
    if (first !== "listen" && first !== "login" && first !== "logout") {
        throw new UsageError(MSG.unknownCommand(shown(first), ctx.cmd));
    }
    const scanned = scan(first, rest, ctx);
    if (scanned.help)
        return { kind: "help", text: HELP_TEXT[first](ctx.cmd) };
    if (first === "logout")
        return { kind: "logout" };
    if (first === "login")
        return { kind: "login", apiKey: scanned.strings.get("api-key") };
    const printSecret = scanned.flags.has("print-secret");
    if (printSecret && scanned.names.some((name) => name !== "print-secret")) {
        throw new UsageError(MSG.printSecretAlone(ctx.cmd));
    }
    return {
        kind: "listen",
        apiKey: scanned.strings.get("api-key"),
        forwardTo: scanned.strings.get("forward-to"),
        events: scanned.events,
        printSecret,
        json: scanned.flags.has("json"),
        skipVerify: scanned.flags.has("skip-verify"),
    };
}
function helpFor(command, ctx) {
    if (command === undefined)
        return { kind: "help", text: HELP.main(ctx.cmd) };
    if (command === "listen" || command === "login" || command === "logout") {
        return { kind: "help", text: HELP_TEXT[command](ctx.cmd) };
    }
    throw new UsageError(MSG.unknownCommand(shown(command), ctx.cmd));
}
const RAYA_SECRET_PREFIX_RE = /^raya_[a-z]{2}_(?:live|test)_/;
/** ¿Parece una clave o credencial de Raya Cash (pegada donde no va)? */
function looksLikeKey(value) {
    return value.startsWith("raya_");
}
/**
 * Un argumento para mostrar en un error: sin caracteres de control y, si parece una clave de Raya
 * Cash, enmascarado como las claves (raya_sk_live_…AbCd): nunca la mostramos entera.
 */
function shown(value) {
    if (!looksLikeKey(value))
        return sanitize(value);
    const prefix = RAYA_SECRET_PREFIX_RE.exec(value)?.[0] ?? "raya_";
    if (value.length <= prefix.length + 8)
        return `${prefix}…`;
    return `${prefix}…${sanitize(value.slice(-4))}`;
}
function scan(command, args, ctx) {
    const spec = OPTIONS[command];
    const { tokens } = parseArgs({
        args,
        options: spec,
        strict: false,
        allowPositionals: true,
        tokens: true,
    });
    const result = {
        help: false,
        names: [],
        strings: new Map(),
        flags: new Set(),
        events: [],
    };
    // --help gana siempre (aunque haya otra opción mal escrita).
    if (tokens.some((token) => token.kind === "option" && token.name === "help")) {
        result.help = true;
        return result;
    }
    let afterEvents = false;
    for (const token of tokens) {
        if (token.kind === "option-terminator")
            continue;
        if (token.kind === "positional") {
            // `-e payment.*` sin comillas: la terminal lo cambió por varios archivos y sobran nombres.
            if (afterEvents)
                throw new UsageError(MSG.unquotedPattern);
            // `rayacash login raya_sk_test_…`: la clave pegada como argumento (nunca entera).
            if (looksLikeKey(token.value) && command === "login") {
                throw new UsageError(MSG.keyArgumentLogin(shown(token.value), ctx.cmd));
            }
            if (looksLikeKey(token.value) && command === "listen") {
                throw new UsageError(MSG.keyArgumentListen(shown(token.value), ctx.cmd));
            }
            throw new UsageError(MSG.unexpectedArgument(shown(token.value), ctx.cmd, command));
        }
        const option = spec[token.name];
        if (option === undefined) {
            throw new UsageError(MSG.unknownOption(sanitize(token.rawName), ctx.cmd, command));
        }
        const name = `--${token.name}`;
        if (option.type === "boolean") {
            if (token.value !== undefined)
                throw new UsageError(MSG.noValue(name));
            result.flags.add(token.name);
            result.names.push(token.name);
            continue;
        }
        const value = token.value;
        // Sin valor, o el valor es otra opción (`-f -e x`): falta el valor.
        if (value === undefined || (!token.inlineValue && value.startsWith("-"))) {
            throw new UsageError(MSG.missingValue(name));
        }
        result.names.push(token.name);
        if (token.name === "events") {
            afterEvents = true;
            // `-e payment.*` sin comillas y un solo archivo que coincide: llega su nombre.
            for (const part of value.split(",")) {
                const item = part.trim();
                if (item && ctx.exists(item))
                    throw new UsageError(MSG.unquotedPattern);
            }
            result.events.push(value);
        }
        else {
            result.strings.set(token.name, value);
        }
    }
    return result;
}
