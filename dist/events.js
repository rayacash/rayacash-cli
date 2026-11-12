// Los eventos que se pueden escuchar en un sandbox y las dos validaciones locales: los valores de
// --events (el servidor es la autoridad sobre los patrones) y cada evento antes de firmarlo.
import { UsageError } from "./args.js";
import { MSG } from "./messages.js";
/** Los tipos que emite un sandbox, en el orden del catálogo. */
export const LISTEN_EVENT_TYPES = Object.freeze([
    "payment.created",
    "payment.succeeded",
    "payment.failed",
    "payment.refunded",
    "connect.order.created",
    "connect.order.succeeded",
    "connect.order.failed",
    "connect.order.refunded",
]);
const LISTENABLE = new Set(LISTEN_EVENT_TYPES);
export const EVENT_ID_RE = /^evt_[0-9A-Za-z]{24}$/;
/**
 * Un par de comillas simples alrededor se descarta: cmd.exe de Windows no las saca, así que
 * `-e 'payment.*'` llega con ellas (bash, zsh, fish y PowerShell sí las sacan). Ningún tipo de
 * evento lleva comillas.
 */
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length < 2 || !trimmed.startsWith("'") || !trimmed.endsWith("'"))
        return trimmed;
    const inside = trimmed.slice(1, -1);
    // 'a','b' no es un par alrededor de todo: cada parte trae el suyo.
    return inside.includes("'") ? trimmed : inside.trim();
}
/** Los valores de -e (repetido o con comas), sin vacíos ni repetidos. */
export function parseEventArgs(values) {
    const events = [];
    for (const value of values) {
        for (const part of unquote(value).split(",")) {
            const item = unquote(part);
            if (item && !events.includes(item))
                events.push(item);
        }
    }
    if (events.length === 0)
        throw new UsageError(MSG.eventsEmpty);
    return events;
}
/**
 * Antes de firmar con el secreto de esta máquina: el body (sin reserializarlo) tiene que ser un
 * objeto JSON de un sandbox (livemode false), con el mismo id y tipo que la API dijo, y un tipo que
 * un sandbox emite. Si no, no se firma ni se reenvía.
 */
export function checkEventBody(event) {
    if (!EVENT_ID_RE.test(event.id) || !LISTENABLE.has(event.type))
        return false;
    let parsed;
    try {
        parsed = JSON.parse(event.body);
    }
    catch {
        return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return false;
    const body = parsed;
    return body.livemode === false && body.id === event.id && body.type === event.type;
}
