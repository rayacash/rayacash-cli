// Todos los textos del CLI, en un solo lugar: los tests los fijan. {cmd} es cómo lo corrés:
// `rayacash` si lo instalaste, o `npx rayacash-cli` si vino por npx (ahí `rayacash` no existe).
import path from "node:path";
import { VERSION } from "./version.js";
const NPX = "npx rayacash-cli";
export function cmdName(env) {
    // npx corre el bin con npm_lifecycle_event=npx (npm exec también); `npm run` pone el script.
    return env.npm_lifecycle_event === "npx" ? NPX : "rayacash";
}
/**
 * Con npx (o npm exec), npm anota el comando entero, con sus argumentos, en sus logs: dónde quedan
 * (npm_config_logs_dir, o _logs adentro de su cache; npm exporta su configuración a los hijos), o
 * null si no corrió por npx.
 */
export function npmLogsDir(env, platform) {
    if (env.npm_lifecycle_event !== "npx")
        return null;
    if (env.npm_config_logs_dir)
        return env.npm_config_logs_dir;
    const join = platform === "win32" ? path.win32.join : path.posix.join;
    if (env.npm_config_cache)
        return join(env.npm_config_cache, "_logs");
    return platform === "win32" ? "%LocalAppData%\\npm-cache\\_logs" : "~/.npm/_logs";
}
const SUPPORT = "soporte@raya.cash";
/** Cómo se actualiza: con npx, instalarlo global no cambia lo que corre npx (va @latest). */
const update = (cmd) => cmd === NPX ? `${NPX}@latest listen` : "npm install -g rayacash-cli";
export const HELP = {
    main: (cmd) => `rayacash-cli ${VERSION} · Escuchá en tu máquina los webhooks de tu sandbox de Raya Cash

Uso:
  ${cmd} <comando> [opciones]

Comandos:
  login     Guarda en esta máquina la clave secreta de prueba de tu sandbox
  listen    Escucha los eventos del sandbox y los reenvía a tu servidor local
  logout    Borra la clave guardada

Opciones:
  -h, --help       Muestra esta ayuda
  -v, --version    Muestra la versión

Más ayuda: ${cmd} <comando> --help
`,
    listen: (cmd) => `Uso: ${cmd} listen [opciones]

Escucha los eventos de webhook de tu sandbox y, con --forward-to, los reenvía
a tu servidor local con el mismo body y los mismos headers que una entrega
real, firmados con el secreto de esta máquina. Te llegan los eventos que
ocurren con la escucha abierta: abrila antes de simular.

Opciones:
  -f, --forward-to <url>   A dónde reenviar cada evento, por ejemplo
                           localhost:3000/webhooks/raya. Sin esta opción,
                           solo los mostramos.
  -e, --events <tipos>     Qué eventos escuchar, separados por comas o
                           repitiendo la opción. Por defecto, todos:
                           payment.created, payment.succeeded, payment.failed,
                           payment.refunded, connect.order.created,
                           connect.order.succeeded, connect.order.failed y
                           connect.order.refunded. También 'payment.*' y
                           'connect.order.*', entre comillas.
      --api-key <clave>    La clave secreta de prueba (raya_sk_test_…). Si no
                           la pasás, usamos RAYA_SECRET_KEY o la que guardaste
                           con ${cmd} login.
      --print-secret       Muestra solo el secreto de firma (whsec_…) y sale.
      --json               Muestra cada evento como una línea de JSON, tal como
                           llega.
      --skip-verify        No verifica el certificado si --forward-to es https
                           (para certificados locales).
  -h, --help               Muestra esta ayuda

Ejemplo:
  ${cmd} listen -e 'payment.*' -f localhost:3000/webhooks/raya
`,
    login: (cmd) => `Uso: ${cmd} login [--api-key <clave>]

Guarda en esta máquina la clave secreta de prueba de tu sandbox
(raya_sk_test_…), en un archivo que solo tu usuario puede leer. La encontrás
en Developers › API Keys, adentro del sandbox. Sin --api-key, te la pedimos
sin mostrarla.
`,
    logout: (cmd) => `Uso: ${cmd} logout

Borra de esta máquina la clave que guardaste con
${cmd} login. El secreto de firma no cambia.
`,
};
export const MSG = {
    version: `rayacash-cli ${VERSION}`,
    nodeTooOld: (version) => `rayacash-cli necesita Node.js 22 o más nuevo (tenés ${version}).`,
    unexpected: (detail) => `rayacash-cli falló: ${detail}. Si sigue, escribinos a ${SUPPORT}.`,
    // Argumentos (exit 2)
    unknownOption: (option, cmd, command) => `No conocemos la opción ${option}. Mirá ${cmd}${command ? ` ${command}` : ""} --help.`,
    missingValue: (option) => `Falta el valor de ${option}.`,
    noValue: (option) => `${option} no lleva valor.`,
    unexpectedArgument: (arg, cmd, command) => `Sobra «${arg}». Mirá ${cmd} ${command} --help.`,
    // Una clave pegada como argumento: se muestra enmascarada (raya_sk_test_…AbCd).
    keyArgumentLogin: (mask, cmd) => `Sobra la clave ${mask}: pasala con --api-key o pegala cuando ${cmd} login te la pide.`,
    keyArgumentListen: (mask, cmd) => `Sobra la clave ${mask}: pasala con --api-key o usá RAYA_SECRET_KEY. Mirá ${cmd} listen --help.`,
    unknownCommand: (command, cmd) => `No conocemos el comando «${command}». Los comandos son login, listen y logout (${cmd} --help).`,
    printSecretAlone: (cmd) => `--print-secret va solo: ${cmd} listen --print-secret.`,
    eventsEmpty: "--events no puede estar vacío: por ejemplo -e payment.succeeded,payment.failed.",
    unquotedPattern: "¿Escribiste payment.* sin comillas? La terminal lo cambió por nombres de archivos: usá -e 'payment.*'.",
    // RAYA_API_BASE (oculta: desarrollo y pruebas)
    apiBaseInvalid: "RAYA_API_BASE tiene que ser https (o http://localhost para pruebas).",
    apiBaseUsing: (base) => `Usando la API en ${base} (RAYA_API_BASE).`,
    // La clave
    keyMissing: (cmd) => `Falta la clave secreta de prueba de tu sandbox (raya_sk_test_…). Guardala con ${cmd} login, pasala con --api-key o definí RAYA_SECRET_KEY.`,
    // npmLogs: con npx y --api-key, npm ya la anotó en sus logs (npmLogsDir).
    keyLive: (origin, npmLogs = null) => `${origin} es de tu cuenta real (raya_sk_live_…). rayacash-cli solo escucha sandboxes: usá la clave secreta de prueba (raya_sk_test_…) de Developers › API Keys, adentro del sandbox. ${npmLogs
        ? `No la usamos, pero npm la anotó en sus logs (${npmLogs}): borrá esos logs y rotá la clave.`
        : "No la usamos ni la guardamos."}`,
    keyPublishable: (origin) => `${origin} es una clave pública (raya_pk_…). Usá la clave secreta de prueba (raya_sk_test_…).`,
    keyOtherCredential: (origin, npmLogs = null) => `${origin} no es una clave secreta: usá la clave secreta de prueba (raya_sk_test_…) de Developers › API Keys, adentro del sandbox.${npmLogs ? ` npm la anotó en sus logs (${npmLogs}): borrá esos logs y rotala.` : ""}`,
    keyInvalid: (origin) => `${origin} no parece una clave secreta de prueba: empieza con raya_sk_test_ y tiene 61 caracteres.`,
    keyEmpty: "No pegaste ninguna clave.",
    envLiveIgnored: "RAYA_SECRET_KEY tiene una clave de tu cuenta real (raya_sk_live_…): rayacash-cli la ignora y no la manda a ningún lado.",
    apiKeyVisible: (cmd) => `Con --api-key la clave queda visible en la lista de procesos mientras escuchás: mejor guardala con ${cmd} login o usá RAYA_SECRET_KEY.`,
    apiKeyNpmLogged: (npmLogs, cmd) => `Con npx, npm anota el comando, con la clave, en sus logs (${npmLogs}): usá RAYA_SECRET_KEY o ${cmd} login.`,
    envKeyWins: (mask, cmd) => `RAYA_SECRET_KEY está definida en esta terminal (${mask}) y tiene prioridad sobre la clave guardada: ${cmd} listen va a usar esa.`,
    tlsRejectIgnored: "Tenés NODE_TLS_REJECT_UNAUTHORIZED=0: rayacash-cli la ignora y verifica igual el certificado de la API de Raya Cash, porque tu clave viaja ahí.",
    // login y logout
    loginPrompt: "Pegá la clave secreta de prueba de tu sandbox (raya_sk_test_…). Está en Developers › API Keys, adentro del sandbox.",
    loginLabel: "Clave: ",
    loginVisible: (cmd) => `Esta terminal no oculta lo que escribís: la clave se va a ver. Si preferís, usá ${cmd} login --api-key … o RAYA_SECRET_KEY.`,
    loginPressEnter: "Pegá la clave y apretá Enter.",
    cancelled: "Cancelado.",
    loginSaved: (mask, path) => `Listo: guardamos la clave ${mask} en ${path}.`,
    loginReplaced: (mask, path, previous) => `Listo: guardamos la clave ${mask} en ${path} (reemplaza a ${previous}).`,
    logoutDone: (mask) => `Listo: borramos la clave ${mask} de esta máquina. El secreto de firma no cambia.`,
    logoutNothing: "No había ninguna clave guardada.",
    // La configuración (exit 1)
    configInsecure: (path) => `Ojo: ${path} lo pueden leer otros usuarios de esta máquina. Corré chmod 600 "${path}".`,
    configBroken: (path, cmd) => `El archivo de configuración ${path} no es JSON válido. Borralo y volvé a correr ${cmd} login.`,
    configWrite: (path, detail) => `No pudimos guardar la configuración en ${path}: ${detail}.`,
    configRead: (path, detail) => `No pudimos leer la configuración en ${path}: ${detail}.`,
    configBusy: "otro proceso de rayacash-cli la está usando",
    // --forward-to (exit 2)
    forwardInvalid: "--forward-to no es una URL válida: usá algo como localhost:3000/webhooks/raya.",
    forwardScheme: "--forward-to tiene que ser http o https.",
    forwardCredentials: "--forward-to no puede llevar usuario ni contraseña.",
    // listen: arranque y estado (stderr)
    /** from: de dónde salió la clave, si no es la guardada (RAYA_SECRET_KEY o --api-key). */
    ready: (name, id, mask, from = null) => `Listo. Escuchando el sandbox «${name}» (${id}) con la clave ${mask}${from ? ` (de ${from})` : ""}.`,
    readyEvents: (events) => `Eventos: ${events.join(", ")}`,
    readyForward: (url) => `Reenviando a ${url}`,
    readyNoForward: "Sin --forward-to: solo mostramos los eventos.",
    readySecret: (secret) => `Secreto de firma: ${secret}  (en tu servidor, como RAYA_WEBHOOK_SECRET)`,
    readyQuit: "Ctrl+C para salir.",
    stopped: "Listo: dejamos de escuchar.",
    // Neutro: el corte puede ser de tu conexión o del lado de la API.
    gap: "La escucha estuvo cortada un rato: los eventos que ocurrieron mientras tanto pueden no haberte llegado. Seguimos escuchando.",
    cursorReset: "Retomamos la escucha desde ahora.",
    offline: (detail, seconds) => `Sin conexión con la API de Raya Cash (${detail}): reintentamos en ${seconds} s.`,
    proxy: (variable) => `Tenés ${variable} definida: rayacash-cli 1.0 no pasa por proxies.`,
    // Nunca sugiere desactivar la verificación.
    apiTls: "No pudimos verificar el certificado de la API de Raya Cash. Si tu red (un proxy de tu empresa o un antivirus) intercepta HTTPS, sumá su CA con NODE_EXTRA_CA_CERTS.",
    reconnected: "Conectado de nuevo.",
    slowDown: "Tu cuenta tiene muchas escuchas abiertas: vamos más despacio.",
    apiUnavailable: "La API no está disponible por ahora: reintentamos en 30 s.",
    apiUnavailableAtStart: "La API de Raya Cash o el sandbox de tu cuenta no están disponibles en este momento. Si en el menú de tu perfil del dashboard no aparece «Crear sandbox» ni «Sandboxes», tu cuenta todavía no lo tiene.",
    signatureHint: (cmd) => `Si tu servidor rechaza la firma, revisá que RAYA_WEBHOOK_SECRET sea el de ${cmd} listen --print-secret (no el de un destino del dashboard).`,
    // listen: la API dijo que no (exit 1, salvo los eventos inválidos: exit 2)
    incompatible: (cmd) => `Esta versión de rayacash-cli no es compatible con la API de Raya Cash. Actualizala con ${update(cmd)}.`,
    keyRejected: (cmd) => `La clave no es válida: revisá que sea la clave secreta de prueba de un sandbox que exista (Developers › API Keys, adentro del sandbox) y guardala de nuevo con ${cmd} login.`,
    keyExpired: (cmd) => `La clave venció o se revocó (también pasa si eliminaste el sandbox). Copiá la vigente en Developers › API Keys del sandbox y guardala con ${cmd} login.`,
    withReason: (message, reason) => `${message} (motivo: ${reason})`,
    notFound: (status, cmd) => `La API de Raya Cash no reconoce la escucha de eventos (${status}). Actualizá rayacash-cli (${update(cmd)}) o escribinos a ${SUPPORT}.`,
    redirect: (status, cmd) => `La API de Raya Cash respondió con una redirección (${status}) y no la seguimos: tu clave solo viaja a la API. Actualizá rayacash-cli (${update(cmd)}) o escribinos a ${SUPPORT}.`,
    rejected: (status) => `La API de Raya Cash rechazó la conexión (${status}). Si sigue, escribinos a ${SUPPORT}.`,
    // listen: detalle de «Sin conexión con la API de Raya Cash ({detalle})»
    detailTimeout: "no respondió en 15 s",
    detailUnexpected: "respuesta inesperada",
    detailTooLarge: "respuesta demasiado grande",
    detailNetwork: "error de red",
    detailStatus: (status, code) => code ? `${status} ${code}` : `HTTP ${status}`,
    // listen: cada evento (después de «<-- [...] POST {url} [{evt}] »)
    forwardOk: (ms) => `${ms} ms`,
    forwardRedirect: "redirección: no la seguimos, como en las entregas reales",
    forwardRefused: (hostPort) => `no se pudo conectar: ¿está corriendo tu servidor en ${hostPort}?`,
    // Conectó y tu servidor cortó: con -f http, muchas veces es un servidor que solo habla https.
    forwardResetHttp: (hostPort, httpsUrl) => `tu servidor en ${hostPort} cortó la conexión: si usa https, probá -f ${httpsUrl}`,
    forwardReset: (hostPort, code) => `tu servidor en ${hostPort} cortó la conexión (${code}).`,
    forwardTimeout: "tu servidor no respondió en 15 s.",
    forwardTls: (code) => `error de TLS (${code}). Si es un certificado local, probá con --skip-verify o sumá tu CA con NODE_EXTRA_CA_CERTS.`,
    forwardNotHttps: (hostPort, httpUrl) => `tu servidor en ${hostPort} no responde por https: ¿quisiste decir ${httpUrl}?`,
    forwardDns: (host) => `no encontramos el host ${host}.`,
    forwardOther: (code) => `la conexión se cortó (${code}).`,
    forwardInvalidEvent: "evento inválido: no lo reenviamos.",
    invalidEventDropped: "evento inválido: lo descartamos.",
};
