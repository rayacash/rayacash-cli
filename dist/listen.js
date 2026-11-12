// `rayacash listen`: el bucle de sondeos, el reenvío de cada evento en orden y en serie, los
// reintentos y las señales. Todo lo de afuera (la API, el reenvío, los streams, los relojes, las
// esperas y las señales) llega por `deps`: los tests lo reemplazan.
import { ApiError } from "./api.js";
import { Backoff } from "./backoff.js";
import { checkEventBody } from "./events.js";
import { isTlsCode } from "./forward.js";
import { maskKey } from "./keys.js";
import { MSG } from "./messages.js";
import { paint, sanitize, timestamp } from "./output.js";
const SEEN_MAX = 10_000;
const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 30_000;
const POLL_DEFAULT_MS = 2_000;
const SLOW_MAX_MS = 10_000;
const SLOW_FOR_MS = 10 * 60_000;
const NOTICE_EVERY_MS = 60_000;
const RETRY_AFTER_DEFAULT_S = 5;
const UNAVAILABLE_WAIT_MS = 30_000;
// npm y la terminal mandan el mismo Ctrl+C dos veces casi juntas: solo cuenta un segundo
// Ctrl+C que llega un segundo o más después del primero.
const SECOND_SIGNAL_MS = 1_000;
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const KEY_FROM = { env: "RAYA_SECRET_KEY", flag: "--api-key" };
/**
 * ¿Node ya pasa el fetch por el proxy de las variables? (NODE_USE_ENV_PROXY o --use-env-proxy en
 * NODE_OPTIONS, en las versiones que lo tienen): ahí la pista de los proxies no aplica.
 */
function nodeUsesEnvProxy(env) {
    return (Boolean(env.NODE_USE_ENV_PROXY) ||
        /(^|\s)--use-env-proxy(?=\s|=|$)/.test(env.NODE_OPTIONS ?? ""));
}
export function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve();
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/**
 * Escucha hasta Ctrl+C (0) o hasta un error que reintentar no arregla (1 o 2). El primer Ctrl+C
 * corta el sondeo y el reenvío en curso y sale con 0; uno segundo, un segundo o más después, sale
 * con 130 en el acto. Si el apagado lo pidió una señal, el handler queda puesto hasta que sale el
 * proceso (main.run lo cierra en medio segundo como mucho): la copia del Ctrl+C que reenvía npm
 * llega unos ms después y, sin handler, Node mataría el proceso con la acción por defecto.
 */
export async function runListen(o, deps) {
    const shutdown = new AbortController();
    let firstSignalAt = null;
    let forceExit;
    const forced = new Promise((resolve) => {
        forceExit = resolve;
    });
    const off = deps.onSignal(() => {
        const now = deps.now();
        if (firstSignalAt === null) {
            firstSignalAt = now;
            shutdown.abort();
        }
        else if (now - firstSignalAt >= SECOND_SIGNAL_MS) {
            forceExit(130);
        }
    });
    try {
        return await Promise.race([new Listener(o, deps, shutdown.signal).run(), forced]);
    }
    finally {
        if (firstSignalAt === null)
            off();
    }
}
class Listener {
    o;
    deps;
    signal;
    /** Donde van las líneas --> y <--: stdout, o stderr con --json (stdout lleva los bodies). */
    lines;
    color;
    seen = new Set();
    backoff;
    cursor = null;
    started = false;
    failure = null;
    signatureHinted = false;
    tlsHinted = false;
    inGap = false;
    intervalMs = POLL_DEFAULT_MS;
    slowMs = 0;
    slowUntil = Number.NEGATIVE_INFINITY;
    lastSlowNotice = Number.NEGATIVE_INFINITY;
    constructor(o, deps, signal) {
        this.o = o;
        this.deps = deps;
        this.signal = signal;
        this.lines = o.json ? deps.stderr : deps.stdout;
        this.color = paint(this.lines, deps.env);
        this.backoff = new Backoff(deps.random);
    }
    note(text) {
        this.deps.stderr.write(`${text}\n`);
    }
    async run() {
        while (!this.signal.aborted) {
            let page;
            try {
                page = await this.deps.api({
                    apiBase: this.o.apiBase,
                    apiKey: this.o.apiKey,
                    events: this.o.events,
                    cursor: this.cursor,
                    signal: this.signal,
                });
            }
            catch (error) {
                if (this.signal.aborted)
                    break;
                if (!(error instanceof ApiError))
                    throw error;
                const step = this.decide(error);
                if (step.kind === "exit") {
                    this.note(step.message);
                    return step.code;
                }
                await this.recover(step, error);
                continue;
            }
            await this.handle(page);
        }
        this.note(MSG.stopped);
        return 0;
    }
    decide(error) {
        const { status, code } = error;
        const exit = (exitCode, message) => ({
            kind: "exit",
            code: exitCode,
            message,
        });
        // Sin respuesta (red, timeout) o un 200 con otra forma: pasajero.
        if (status === 0 || status === 200)
            return { kind: "retry" };
        if (status >= 300 && status < 400)
            return exit(1, MSG.redirect(status, this.o.cmd));
        if (status === 400 && code === "PARAMETER_INVALID") {
            const field = fieldOf(error.data);
            if (field === "events" && error.serverMessage)
                return exit(2, sanitize(error.serverMessage));
            if (field === "cursor" && this.cursor !== null)
                return { kind: "reset" };
        }
        if (status === 401 && code === "API_KEY_INVALID")
            return exit(1, MSG.keyRejected(this.o.cmd));
        if (status === 401 && code === "API_KEY_EXPIRED")
            return exit(1, MSG.keyExpired(this.o.cmd));
        if (status === 401 || status === 403) {
            // Nunca se reintenta: con la misma clave, la respuesta va a ser la misma.
            if (!error.serverMessage)
                return exit(1, MSG.rejected(status));
            const message = sanitize(error.serverMessage);
            const reason = reasonOf(error.data);
            return exit(1, reason ? MSG.withReason(message, sanitize(reason)) : message);
        }
        if (status === 404 || status === 405)
            return exit(1, MSG.notFound(status, this.o.cmd));
        if (status === 429)
            return { kind: "rate" };
        if (status === 503 && code === "API_UNAVAILABLE") {
            return this.started ? { kind: "unavailable" } : exit(1, MSG.apiUnavailableAtStart);
        }
        if (status >= 500)
            return { kind: "retry" };
        // Otro 400, un 413 u otro 4xx: lo que mandamos ya no es lo que la API espera.
        return exit(1, MSG.incompatible(this.o.cmd));
    }
    async recover(step, error) {
        switch (step.kind) {
            case "reset":
                this.note(MSG.cursorReset);
                this.cursor = null;
                return;
            case "rate": {
                const now = this.deps.now();
                // Más despacio por 10 minutos: el doble, hasta 10 s.
                this.slowMs = Math.min(Math.max(this.slowMs, this.intervalMs) * 2, SLOW_MAX_MS);
                this.slowUntil = now + SLOW_FOR_MS;
                if (now - this.lastSlowNotice >= NOTICE_EVERY_MS) {
                    this.lastSlowNotice = now;
                    this.note(MSG.slowDown);
                }
                const seconds = clamp(error.retryAfter ?? RETRY_AFTER_DEFAULT_S, 1, 60);
                await this.deps.sleep(seconds * 1000, this.signal);
                return;
            }
            case "unavailable":
                if (this.failure !== "unavailable")
                    this.note(MSG.apiUnavailable);
                this.failure = "unavailable";
                await this.deps.sleep(UNAVAILABLE_WAIT_MS, this.signal);
                return;
            case "retry": {
                const wait = this.backoff.next();
                const { env } = this.deps;
                if (this.failure !== "offline") {
                    this.note(MSG.offline(error.detail, Math.max(1, Math.round(wait / 1000))));
                    const proxy = error.network && !nodeUsesEnvProxy(env)
                        ? PROXY_VARS.find((name) => env[name])
                        : undefined;
                    if (proxy)
                        this.note(MSG.proxy(proxy));
                }
                // Un certificado que no verifica no se arregla solo: la pista, una vez por corrida.
                if (error.network && !this.tlsHinted && isTlsCode(error.detail)) {
                    this.tlsHinted = true;
                    this.note(MSG.apiTls);
                }
                this.failure = "offline";
                await this.deps.sleep(wait, this.signal);
                return;
            }
        }
    }
    async handle(page) {
        if (this.failure !== null) {
            // «de nuevo» solo si ya se había conectado (un primer sondeo fallido no cuenta).
            if (this.started)
                this.note(MSG.reconnected);
            this.failure = null;
        }
        this.backoff.reset();
        if (!this.started) {
            this.started = true;
            this.ready(page);
        }
        // Una vez por racha: mientras la API no puede mantener la escucha, cada sondeo trae gap, y el
        // aviso no se repite cada 2 s.
        if (page.gap && !this.inGap)
            this.note(MSG.gap);
        this.inGap = page.gap;
        for (const event of page.data) {
            if (this.signal.aborted)
                return;
            if (this.seen.has(event.id)) {
                // Ya lo mostramos (la API entrega al menos una vez): se saltea y queda como reciente.
                this.seen.delete(event.id);
                this.seen.add(event.id);
                continue;
            }
            this.remember(event.id);
            await this.deliver(event, page.events);
        }
        if (this.signal.aborted)
            return;
        this.cursor = page.cursor;
        this.intervalMs = clamp(page.poll_interval_ms, POLL_MIN_MS, POLL_MAX_MS);
        if (page.has_more)
            return;
        const slow = this.deps.now() < this.slowUntil ? this.slowMs : 0;
        await this.deps.sleep(Math.max(this.intervalMs, slow), this.signal);
    }
    remember(id) {
        this.seen.add(id);
        if (this.seen.size > SEEN_MAX) {
            const oldest = this.seen.values().next().value;
            if (oldest !== undefined)
                this.seen.delete(oldest);
        }
    }
    ready(page) {
        const { o } = this;
        const from = o.keySource ? (KEY_FROM[o.keySource] ?? null) : null;
        this.note(MSG.ready(sanitize(page.sandbox.name), sanitize(page.sandbox.id), maskKey(o.apiKey), from));
        this.note(MSG.readyEvents(page.events.map(sanitize)));
        this.note(o.forwardTo ? MSG.readyForward(o.forwardTo.href) : MSG.readyNoForward);
        this.note(MSG.readySecret(o.secret));
        this.note(MSG.readyQuit);
    }
    line(text) {
        this.lines.write(`${timestamp(this.deps.clock())}  ${text}\n`);
    }
    /** `asked`: los tipos efectivos que devolvió la API; solo esos se firman. */
    async deliver(event, asked) {
        const { o, color } = this;
        this.line(`--> ${sanitize(event.type)} [${event.id}]`);
        const target = o.forwardTo;
        if (!asked.includes(event.type) || !checkEventBody(event)) {
            this.line(color.red(target
                ? `<-- [ERROR] POST ${target.href} [${event.id}] ${MSG.forwardInvalidEvent}`
                : `<-- [ERROR] [${event.id}] ${MSG.invalidEventDropped}`));
            return;
        }
        if (o.json)
            this.deps.stdout.write(`${event.body}\n`);
        if (target === null)
            return;
        const result = await this.deps.forward(target, event, o.secret, {
            skipVerify: o.skipVerify,
            signal: this.signal,
        });
        if (this.signal.aborted)
            return;
        this.line(describe(result, target, event.id, color));
        const status = result.status;
        if (!this.signatureHinted && (status === 400 || status === 401 || status === 403)) {
            this.signatureHinted = true;
            this.note(MSG.signatureHint(o.cmd));
        }
    }
}
function fieldOf(data) {
    return data?.field;
}
function reasonOf(data) {
    const reason = data?.reason;
    return typeof reason === "string" && reason ? reason : null;
}
/** `host:puerto`, con el puerto por defecto si la URL no lo trae. */
function hostPort(target) {
    if (target.port)
        return target.host;
    return `${target.host}:${target.protocol === "https:" ? 443 : 80}`;
}
function describe(result, target, id, color) {
    const head = (label) => `<-- [${label}] POST ${target.href} [${id}]`;
    const status = result.status;
    if (status !== undefined) {
        const ms = MSG.forwardOk(Math.round(result.durationMs ?? 0));
        if (status >= 200 && status < 300)
            return color.green(`${head(status)} ${ms}`);
        if (status >= 300 && status < 400)
            return color.yellow(`${head(status)} ${MSG.forwardRedirect}`);
        if (status >= 500)
            return color.red(`${head(status)} ${ms}`);
        return color.yellow(`${head(status)} ${ms}`);
    }
    const code = result.code ?? "?";
    let text;
    switch (result.error) {
        case "refused":
            text = MSG.forwardRefused(hostPort(target));
            break;
        case "reset":
            if (target.protocol === "http:") {
                const secure = new URL(target.href);
                secure.protocol = "https:";
                text = MSG.forwardResetHttp(hostPort(target), secure.href);
            }
            else {
                text = MSG.forwardReset(hostPort(target), code);
            }
            break;
        case "timeout":
            text = MSG.forwardTimeout;
            break;
        case "tls":
            if (code === "EPROTO") {
                const plain = new URL(target.href);
                plain.protocol = "http:";
                text = MSG.forwardNotHttps(hostPort(target), plain.href);
            }
            else {
                text = MSG.forwardTls(code);
            }
            break;
        case "dns":
            text = MSG.forwardDns(target.hostname);
            break;
        case "invalid":
            text = MSG.forwardInvalidEvent;
            break;
        default:
            text = MSG.forwardOther(code);
    }
    return color.red(`${head("ERROR")} ${text}`);
}
