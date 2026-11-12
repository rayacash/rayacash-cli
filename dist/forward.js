// El reenvío a tu servidor: un POST por evento con el body exacto y los headers de una entrega
// real, firmado con el secreto de esta máquina. Como las entregas reales: 5 s para conectar, 15 s
// para la respuesta, se leen como mucho 64 KB en 5 s y se descartan, sin seguir redirecciones y un
// solo intento. node:http y no fetch: --skip-verify vale solo para este request.
import { randomInt } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { UsageError } from "./args.js";
import { checkEventBody } from "./events.js";
import { MSG } from "./messages.js";
import { signatureHeader } from "./signature.js";
export const WEBHOOK_USER_AGENT = "Raya-Webhooks/1.0";
export const FORWARD_TIMEOUTS = {
    connectMs: 5_000,
    responseMs: 15_000,
    drainMs: 5_000,
    maxBodyBytes: 64 * 1024,
};
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const REFUSED = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH"]);
const RESET = new Set(["ECONNRESET", "EPIPE"]);
const DNS = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const TLS_RE = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/;
/** ¿Es el código de un certificado que no verifica (o de otro error de TLS)? */
export function isTlsCode(code) {
    return TLS_RE.test(code);
}
/**
 * --forward-to: `localhost:3000/webhooks/raya` pasa a `http://localhost:3000/webhooks/raya`,
 * `3000` a `http://localhost:3000/` y `:3000/x` a `http://localhost:3000/x`. Hay esquema solo si
 * empieza con `algo://` (así `localhost:3000` no es el esquema `localhost:`). Solo http y https,
 * sin usuario ni contraseña; cualquier host (sale desde tu máquina).
 */
export function normalizeForwardUrl(raw) {
    const value = raw.trim();
    let candidate;
    if (SCHEME_RE.test(value))
        candidate = value;
    else if (/^\d{1,5}$/.test(value))
        candidate = `http://localhost:${value}/`;
    else if (/^:\d/.test(value))
        candidate = `http://localhost${value}`;
    else
        candidate = `http://${value}`;
    let url;
    try {
        url = new URL(candidate);
    }
    catch {
        throw new UsageError(MSG.forwardInvalid);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new UsageError(MSG.forwardScheme);
    }
    if (url.username || url.password)
        throw new UsageError(MSG.forwardCredentials);
    if (!url.hostname)
        throw new UsageError(MSG.forwardInvalid);
    return url;
}
/** whd_ + 24 caracteres base62 al azar, uno nuevo por reenvío. */
export function deliveryId() {
    let id = "whd_";
    for (let i = 0; i < 24; i += 1)
        id += BASE62[randomInt(62)];
    return id;
}
/** connected: el error llegó después de conectar (un corte de tu servidor, no un «no está»). */
export function classifyNetworkError(code, https, connected = false) {
    if (connected && RESET.has(code))
        return { error: "reset", code };
    if (REFUSED.has(code))
        return { error: "refused", code };
    if (DNS.has(code))
        return { error: "dns", code };
    // EPROTO contra https: del otro lado hay un servidor http.
    if (TLS_RE.test(code) || (https && code === "EPROTO"))
        return { error: "tls", code };
    return { error: "other", code };
}
export function forward(target, event, secret, o) {
    if (!checkEventBody(event))
        return Promise.resolve({ error: "invalid" });
    const limits = { ...FORWARD_TIMEOUTS, ...o.timeouts };
    const body = Buffer.from(event.body, "utf8");
    const timestamp = Math.floor((o.now ?? Date.now)() / 1000);
    const https = target.protocol === "https:";
    const headers = {
        "Content-Type": "application/json",
        "User-Agent": WEBHOOK_USER_AGENT,
        "Raya-Event-Id": event.id,
        "Raya-Event-Type": event.type,
        "Raya-Delivery-Id": deliveryId(),
        "Raya-Signature": signatureHeader(secret, timestamp, body),
        "Accept-Encoding": "identity",
        "Content-Length": String(body.length),
    };
    return new Promise((resolve) => {
        const started = performance.now();
        const timers = [];
        let settled = false;
        const later = (ms, run) => {
            const timer = setTimeout(run, ms);
            timers.push(timer);
            return timer;
        };
        const request = (https ? httpsRequest : httpRequest)({
            protocol: target.protocol,
            // [::1] → ::1
            hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
            port: target.port || (https ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: "POST",
            headers,
            // Sin pool: un intento, Connection: close.
            agent: false,
            ...(https ? { rejectUnauthorized: !o.skipVerify } : {}),
        });
        const onAbort = () => done({ error: "other", code: "ABORT_ERR" });
        const done = (result) => {
            if (settled)
                return;
            settled = true;
            for (const timer of timers)
                clearTimeout(timer);
            o.signal.removeEventListener("abort", onAbort);
            request.destroy();
            resolve(result);
        };
        o.signal.addEventListener("abort", onAbort, { once: true });
        const connectTimer = later(limits.connectMs, () => done({ error: "refused", code: "ETIMEDOUT" }));
        let responseTimer;
        let isConnected = false;
        request.once("socket", (socket) => {
            const connected = () => {
                isConnected = true;
                clearTimeout(connectTimer);
                responseTimer = later(limits.responseMs, () => done({ error: "timeout", code: "ETIMEDOUT" }));
            };
            if (socket.connecting)
                socket.once("connect", connected);
            else
                connected();
        });
        // Con la respuesta ya recibida, un corte al leer el body no cambia el resultado.
        let received = null;
        request.on("error", (error) => {
            done(received ?? classifyNetworkError(error.code ?? "UNKNOWN", https, isConnected));
        });
        request.once("response", (response) => {
            clearTimeout(connectTimer);
            clearTimeout(responseTimer);
            const result = { status: response.statusCode ?? 0, durationMs: performance.now() - started };
            received = result;
            let read = 0;
            const finish = () => done(result);
            later(limits.drainMs, finish);
            response.on("data", (chunk) => {
                read += chunk.length;
                if (read >= limits.maxBodyBytes)
                    finish();
            });
            response.once("end", finish);
            response.once("error", finish);
        });
        if (o.signal.aborted)
            onAbort();
        else
            request.end(body);
    });
}
