// La API de Raya Cash. RAYA_API_BASE la cambia solo para desarrollo y pruebas (no aparece en la
// ayuda): https://<host>[:puerto] sin path, query, fragmento ni credenciales, o http:// solo para
// localhost, 127.0.0.1 y [::1].
import { UsageError } from "./args.js";
import { MSG } from "./messages.js";
export const DEFAULT_API_BASE = "https://api.raya.cash";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function resolveApiBase(env) {
    const raw = env.RAYA_API_BASE?.trim();
    if (!raw)
        return { base: DEFAULT_API_BASE, custom: false };
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new UsageError(MSG.apiBaseInvalid);
    }
    const secure = url.protocol === "https:" && url.hostname !== "";
    const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
    // `?` y `#` vacíos también cuentan: URL los borra de search y hash.
    const extra = url.pathname !== "/" || /[?#]/.test(raw) || url.username || url.password;
    if (!(secure || local) || extra)
        throw new UsageError(MSG.apiBaseInvalid);
    return { base: `${url.protocol}//${url.host}`, custom: true };
}
