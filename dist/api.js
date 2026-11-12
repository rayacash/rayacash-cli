// El sondeo: POST /v1/test/webhooks/listen con la clave secreta de prueba. Nunca sigue una
// redirección (la clave solo viaja a la API) y nunca manda Raya-Sandbox: la clave ya dice el
// sandbox. Una respuesta 200 se valida entera; si no tiene la forma esperada, es un error pasajero.
import { EVENT_ID_RE } from "./events.js";
import { MSG } from "./messages.js";
import { VERSION } from "./version.js";
export const LISTEN_PATH = "/v1/test/webhooks/listen";
export const POLL_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export class ApiError extends Error {
    status;
    code;
    serverMessage;
    data;
    retryAfter;
    detail;
    network;
    constructor(init) {
        super(init.serverMessage || init.detail);
        this.name = "ApiError";
        this.status = init.status;
        this.code = init.code ?? null;
        this.serverMessage = init.serverMessage ?? null;
        this.data = init.data ?? null;
        this.retryAfter = init.retryAfter ?? null;
        this.detail = init.detail;
        this.network = init.network ?? false;
    }
}
/** `rayacash-cli/1.0.0 Node/22.12.0 undici/6.21.0`. */
export function userAgent() {
    let agent = `rayacash-cli/${VERSION} Node/${process.versions.node}`;
    const undici = process.versions.undici;
    if (undici)
        agent += ` undici/${undici}`;
    return agent;
}
export async function pollEvents(o) {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? POLL_TIMEOUT_MS);
    const signal = AbortSignal.any([o.signal, timeout]);
    const payload = o.cursor === null ? { events: o.events } : { events: o.events, cursor: o.cursor };
    let response;
    let bytes;
    try {
        response = await fetch(`${o.apiBase}${LISTEN_PATH}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${o.apiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": userAgent(),
            },
            body: JSON.stringify(payload),
            redirect: "manual",
            signal,
        });
        bytes = await readBody(response, o.maxBytes ?? MAX_RESPONSE_BYTES);
    }
    catch (error) {
        if (o.signal.aborted)
            throw error;
        if (timeout.aborted) {
            throw new ApiError({ status: 0, detail: MSG.detailTimeout, network: true });
        }
        if (error instanceof TooLarge)
            throw new ApiError({ status: 0, detail: MSG.detailTooLarge });
        throw new ApiError({ status: 0, detail: networkDetail(error), network: true });
    }
    if (response.status === 200) {
        const page = parsePage(bytes);
        if (page === null)
            throw new ApiError({ status: 200, detail: MSG.detailUnexpected });
        return page;
    }
    const failure = parseError(bytes);
    throw new ApiError({
        status: response.status,
        code: failure?.code ?? null,
        serverMessage: failure?.message ?? null,
        data: failure?.data ?? null,
        retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        detail: MSG.detailStatus(response.status, failure?.code ?? null),
    });
}
class TooLarge extends Error {
}
async function readBody(response, maxBytes) {
    const reader = response.body?.getReader();
    if (!reader)
        return new Uint8Array();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw new TooLarge();
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
function parseJson(bytes) {
    try {
        // UTF-8 estricto: lo que no es UTF-8 válido no es la respuesta de la API.
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch {
        return undefined;
    }
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isEvent(value) {
    return (isObject(value) &&
        typeof value.id === "string" &&
        EVENT_ID_RE.test(value.id) &&
        typeof value.type === "string" &&
        typeof value.body === "string");
}
/** La respuesta 200, o null si no tiene la forma del contrato. */
export function parsePage(bytes) {
    const value = parseJson(bytes);
    if (!isObject(value) || value.object !== "webhook_listen")
        return null;
    const { sandbox, events, data, has_more, cursor, gap, poll_interval_ms } = value;
    if (!isObject(sandbox) || typeof sandbox.id !== "string" || typeof sandbox.name !== "string") {
        return null;
    }
    if (!Array.isArray(events) || !events.every((item) => typeof item === "string"))
        return null;
    if (!Array.isArray(data) || !data.every(isEvent))
        return null;
    if (typeof has_more !== "boolean" || typeof gap !== "boolean")
        return null;
    if (typeof cursor !== "string" || cursor === "")
        return null;
    if (typeof poll_interval_ms !== "number" || !Number.isFinite(poll_interval_ms))
        return null;
    return {
        object: "webhook_listen",
        sandbox: { id: sandbox.id, name: sandbox.name },
        events,
        data: data.map((event) => ({ id: event.id, type: event.type, body: event.body })),
        has_more,
        cursor,
        gap,
        poll_interval_ms,
    };
}
/** El envelope {"error": {code, message, data}} de la API, o null (HTML, otro JSON). */
function parseError(bytes) {
    const value = parseJson(bytes);
    const error = isObject(value) ? value.error : undefined;
    if (!isObject(error) || typeof error.code !== "string")
        return null;
    return {
        code: error.code,
        message: typeof error.message === "string" ? error.message : "",
        data: error.data ?? null,
    };
}
/** Retry-After en segundos (solo la forma con números), o null. */
export function parseRetryAfter(value) {
    if (value === null || !/^\d{1,9}$/.test(value.trim()))
        return null;
    return Number(value.trim());
}
/** El código del error de red (fetch lo deja en la causa, o en la primera de varias). */
export function networkDetail(error) {
    const cause = error?.cause ?? error;
    const code = cause?.code;
    if (typeof code === "string")
        return code;
    const nested = cause?.errors;
    if (Array.isArray(nested)) {
        const first = nested[0]?.code;
        if (typeof first === "string")
            return first;
    }
    return MSG.detailNetwork;
}
