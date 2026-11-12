// La salida: colores por stream, la hora local de cada línea y la limpieza de los textos que vienen
// del servidor (el nombre del sandbox, un tipo de evento, un mensaje de error).
/**
 * Con color si el stream es una terminal, salvo NO_COLOR (definida y no vacía) o TERM=dumb.
 * FORCE_COLOR los fuerza (y FORCE_COLOR=0 los apaga, como en Node).
 */
export function useColor(stream, env) {
    const force = env.FORCE_COLOR;
    if (force !== undefined)
        return force !== "0";
    if (env.NO_COLOR)
        return false;
    if (env.TERM === "dumb")
        return false;
    return stream.isTTY === true;
}
export function paint(stream, env) {
    const on = useColor(stream, env);
    const wrap = (open) => (text) => on ? `\u001b[${open}m${text}\u001b[39m` : text;
    return { green: wrap(32), yellow: wrap(33), red: wrap(31) };
}
/** `2026-11-12 10:31:02`, en la hora local de esta máquina. */
export function timestamp(date) {
    const two = (value) => String(value).padStart(2, "0");
    return (`${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
        `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`);
}
/** Saca los caracteres de control (C0, DEL y C1): un texto ajeno no maneja tu terminal. */
export function sanitize(text) {
    let clean = "";
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
            continue;
        clean += char;
    }
    return clean;
}
