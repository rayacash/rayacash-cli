// @ts-check
// Reporter de node:test para GitHub Actions: cada test que falla deja una anotación (::error) con
// su nombre y el error, visible en el resumen del job y en los pull requests. scripts/test.mjs lo
// suma al reporter de siempre solo adentro de GitHub Actions (GITHUB_ACTIONS=true).

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** @param {string} value */
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** @param {string} value */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** @param {string} file */
function relative(file) {
  const local = file.startsWith("file:") ? fileURLToPath(file) : file;
  return path.relative(ROOT, local).split(path.sep).join("/");
}

/** @param {unknown} error */
function describe(error) {
  if (error && typeof error === "object") {
    const { cause, message } = /** @type {{ cause?: unknown, message?: unknown }} */ (error);
    if (cause && typeof cause === "object" && "message" in cause) {
      return String(/** @type {{ message: unknown }} */ (cause).message);
    }
    if (message !== undefined) return String(message);
  }
  return String(error ?? "falló");
}

/** @param {AsyncIterable<{ type: string, data: any }>} source */
export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, details, file, line } = event.data;
    // Una suite (describe) falla cuando falla un test suyo: ese ya tiene su anotación.
    if (details?.type === "suite") continue;
    const properties = [`title=${escapeProperty(String(name))}`];
    if (file) properties.push(`file=${escapeProperty(relative(String(file)))}`);
    if (line) properties.push(`line=${line}`);
    const message = describe(details?.error).slice(0, 4000);
    yield `::error ${properties.join(",")}::${escapeData(message)}\n`;
  }
}
