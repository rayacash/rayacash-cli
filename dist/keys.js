// La clave: solo la secreta de prueba de un sandbox (raya_sk_test_…). Se valida acá, antes de
// cualquier red: una clave de la cuenta real nunca sale de esta máquina.
import { UsageError } from "./args.js";
import { MSG } from "./messages.js";
export const TEST_SECRET_KEY_RE = /^raya_sk_test_[0-9A-Za-z]{48}$/;
const ORIGINS = {
    flag: "La clave de --api-key",
    env: "La clave de RAYA_SECRET_KEY",
    config: "La clave guardada",
    input: "Esa clave",
};
export function classifyKey(raw) {
    if (TEST_SECRET_KEY_RE.test(raw))
        return "test_secret";
    if (raw.startsWith("raya_sk_live_"))
        return "live_secret";
    if (raw.startsWith("raya_pk_"))
        return "publishable";
    if (raw.startsWith("raya_at_") || raw.startsWith("raya_cs_"))
        return "other_credential";
    return "invalid";
}
/**
 * La clave sin el espacio de alrededor, o un UsageError (exit 2) que dice qué tiene de malo.
 * npmLogs: la clave vino por --api-key con npx, y npm ya la anotó en sus logs (ahí).
 */
export function checkKey(raw, source, npmLogs = null) {
    const key = raw.trim();
    if (source === "input" && key === "")
        throw new UsageError(MSG.keyEmpty);
    const origin = ORIGINS[source];
    switch (classifyKey(key)) {
        case "test_secret":
            return key;
        case "live_secret":
            throw new UsageError(MSG.keyLive(origin, npmLogs));
        case "publishable":
            throw new UsageError(MSG.keyPublishable(origin));
        case "other_credential":
            throw new UsageError(MSG.keyOtherCredential(origin, npmLogs));
        default:
            throw new UsageError(MSG.keyInvalid(origin));
    }
}
const MASK_PREFIXES = ["raya_sk_live_", "raya_sk_test_", "raya_at_live_", "raya_at_test_"];
/** `raya_sk_test_…AbCd`: nunca mostramos la clave entera. */
export function maskKey(key) {
    const prefix = MASK_PREFIXES.find((candidate) => key.startsWith(candidate)) ?? "";
    if (key.length <= prefix.length + 8)
        return `${prefix}…`;
    return `${prefix}…${key.slice(-4)}`;
}
/**
 * --api-key > RAYA_SECRET_KEY > la guardada. Una fuente con una clave inválida es un error (nunca
 * se cae en silencio a la siguiente), salvo una clave de la cuenta real en RAYA_SECRET_KEY: es la
 * variable de los SDKs, así que se ignora con un aviso y se sigue con la guardada.
 */
export function resolveKey(o) {
    if (o.flag !== undefined) {
        return { key: checkKey(o.flag, "flag", o.npmLogs ?? null), source: "flag" };
    }
    const fromEnv = o.env.RAYA_SECRET_KEY?.trim();
    if (fromEnv) {
        if (classifyKey(fromEnv) !== "live_secret") {
            return { key: checkKey(fromEnv, "env"), source: "env" };
        }
        o.warn(MSG.envLiveIgnored);
    }
    if (o.saved !== undefined && o.saved !== null) {
        if (typeof o.saved !== "string")
            throw new UsageError(MSG.keyInvalid(ORIGINS.config));
        return { key: checkKey(o.saved, "config"), source: "config" };
    }
    throw new UsageError(MSG.keyMissing(o.cmd));
}
