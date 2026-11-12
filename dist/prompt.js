// Leer la clave en `rayacash login`, sin dependencias. Con una terminal, en modo raw y sin eco;
// sin terminal (un pipe, o mintty sin TTY), hasta el primer Enter o el final de la entrada.
const ESC = "\u001b";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);
/** Sin los marcadores de pegado de la terminal ni caracteres de control. */
function clean(value) {
    let text = "";
    for (const char of value.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "")) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
            continue;
        text += char;
    }
    return text;
}
/**
 * La clave sin mostrarla: Enter termina, Backspace borra, Ctrl+C (o Ctrl+D sin nada escrito)
 * cancela y devuelve null. La terminal vuelve a la normalidad al terminar, y también si el proceso
 * sale antes (onExit).
 */
export function readHidden(o) {
    const { input, output } = o;
    return new Promise((resolve) => {
        let value = "";
        // Las secuencias de escape (los marcadores de pegado, las flechas) se descartan enteras,
        // también si llegan partidas: así Backspace borra lo que escribiste y no un pedazo de ellas.
        let sequence = "none";
        const restore = () => input.setRawMode?.(false);
        const offExit = o.onExit(restore);
        const finish = (result) => {
            restore();
            offExit();
            input.removeListener("data", onData);
            input.removeListener("end", onEnd);
            input.pause();
            output.write("\n");
            resolve(result);
        };
        const onData = (chunk) => {
            for (const char of String(chunk)) {
                if (sequence === "esc") {
                    sequence = char === "[" ? "csi" : char === "O" ? "ss3" : "none";
                    continue;
                }
                if (sequence === "ss3") {
                    sequence = "none";
                    continue;
                }
                if (sequence === "csi") {
                    // Parámetros e intermedios (0x20–0x3f) hasta el byte final.
                    const code = char.codePointAt(0) ?? 0;
                    if (code < 0x20 || code > 0x3f)
                        sequence = "none";
                    continue;
                }
                if (char === ESC) {
                    sequence = "esc";
                    continue;
                }
                if (char === "\r" || char === "\n")
                    return finish(clean(value));
                if (char === CTRL_C)
                    return finish(null);
                if (char === CTRL_D) {
                    if (clean(value) === "")
                        return finish(null);
                    continue;
                }
                if (BACKSPACE.has(char)) {
                    value = value.slice(0, -1);
                    continue;
                }
                value += char;
            }
        };
        const onEnd = () => finish(clean(value));
        output.write(o.prompt);
        input.setRawMode?.(true);
        input.setEncoding("utf8");
        input.on("data", onData);
        input.on("end", onEnd);
        input.resume();
    });
}
/** Sin terminal: hasta el primer salto de línea o el final de la entrada. */
export function readLine(input) {
    return new Promise((resolve, reject) => {
        let buffer = "";
        const stop = () => {
            input.removeListener("data", onData);
            input.removeListener("end", onEnd);
            input.removeListener("error", onError);
            input.pause();
        };
        const onData = (chunk) => {
            buffer += String(chunk);
            const end = buffer.indexOf("\n");
            if (end >= 0) {
                buffer = buffer.slice(0, end);
                onEnd();
            }
        };
        const onEnd = () => {
            stop();
            resolve(clean(buffer));
        };
        const onError = (error) => {
            stop();
            reject(error);
        };
        input.setEncoding("utf8");
        input.on("data", onData);
        input.on("end", onEnd);
        input.on("error", onError);
        input.resume();
    });
}
