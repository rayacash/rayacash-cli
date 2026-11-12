import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { ROOT, tempDir } from "./helpers.ts";

const README = readFileSync(path.join(ROOT, "README.md"), "utf8");
const CHANGELOG = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
const PACKAGE = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
};

function blocks(text: string, language: string): string[] {
  const found: string[] = [];
  const fence = new RegExp(`^( *)\`\`\`${language}\\n([\\s\\S]*?)^\\1\`\`\`$`, "gm");
  for (const match of text.matchAll(fence)) found.push(match[2] ?? "");
  return found;
}

/** El texto sin lo que va entre comillas simples o dobles. */
function unquoted(line: string): string {
  return line.replace(/'[^']*'|"[^"]*"/g, "");
}

describe("README", () => {
  test("la línea «Versión» es la de package.json, y el CHANGELOG la tiene", () => {
    assert.match(
      README,
      new RegExp(
        `^Versión ${PACKAGE.version.replaceAll(".", "\\.")}\\. Requiere Node\\.js 22 o más nuevo\\.`,
        "m",
      ),
    );
    assert.match(CHANGELOG, new RegExp(`^## ${PACKAGE.version.replaceAll(".", "\\.")}$`, "m"));
  });

  test("el índice es exactamente la lista de secciones", () => {
    const headings = [...README.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    const index = README.split("## Contenido\n")[1]?.split("\n## ")[0] ?? "";
    const entries = [...index.matchAll(/^- \[(.+)\]\(#(.+)\)$/gm)];
    assert.deepEqual(
      entries.map((match) => match[1]),
      headings.filter((heading) => heading !== "Contenido"),
    );
    for (const match of entries) {
      const anchor = (match[1] ?? "").toLowerCase().replaceAll(" ", "-");
      assert.equal(match[2], anchor);
    }
  });

  test("los bloques js compilan y tienen los imports juntos", () => {
    const sources = blocks(README, "js");
    assert.ok(sources.length > 0);
    const dir = tempDir();
    sources.forEach((source, i) => {
      const file = path.join(dir, `bloque-${i}.mjs`);
      writeFileSync(file, source);
      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      assert.equal(check.status, 0, check.stderr);
      const lines = source.split("\n");
      const imports = lines.flatMap((line, at) => (line.startsWith("import ") ? [at] : []));
      if (imports.length > 1) {
        assert.equal(imports.at(-1), (imports[0] ?? 0) + imports.length - 1, "imports juntos");
      }
    });
  });

  test("todo * de un bloque bash va entre comillas (la terminal no lo toca)", () => {
    const bash = blocks(README, "bash");
    assert.ok(bash.length >= 5);
    for (const block of bash) {
      for (const line of block.split("\n")) {
        assert.equal(unquoted(line).includes("*"), false, line);
      }
    }
    // En el texto, los patrones también van entre comillas.
    assert.doesNotMatch(README, /-e (?:payment|connect\.order)\.\*/);
    assert.doesNotMatch(CHANGELOG, /-e (?:payment|connect\.order)\.\*/);
  });

  test("con npx nunca manda a un `rayacash` que no existe", () => {
    for (const block of blocks(README, "bash")) {
      if (block.includes("npx ")) assert.doesNotMatch(block, /(^|[^-])rayacash (login|listen)/m);
    }
    // Adentro de $(…), npx va con --yes.
    for (const match of README.matchAll(/\$\(([^)]*)\)/g)) {
      if (match[1]?.includes("npx")) assert.match(match[1], /^npx --yes /);
    }
  });

  test("el sandbox va condicionado y el cierre es el de los SDKs", () => {
    const condition =
      "si en el menú de tu perfil del dashboard aparece «Crear sandbox» o «Sandboxes»";
    assert.ok(README.split("\n")[2]?.includes(condition));
    assert.ok(CHANGELOG.includes(condition));
    assert.ok(
      README.endsWith(
        "\n---\n\nReferencia de la API: https://raya.cash/api · Soporte: soporte@raya.cash\n\nRaya Cash S.A\n",
      ),
    );
    // Nada de lo interno ni lo que todavía no es público.
    for (const hidden of [
      /RAYA_API_BASE/,
      /\/api\/sandbox/,
      /\bapi\.raya\.cash\b/,
      /interruptor/i,
      /piloto/i,
    ]) {
      assert.doesNotMatch(README, hidden);
      assert.doesNotMatch(CHANGELOG, hidden);
    }
    assert.doesNotMatch(README, /en orden/);
  });

  test("lo que el CLI hace de verdad (npx, zsh, Windows, proxies, TLS y los códigos de salida)", () => {
    // Con npx, npm anota el comando (con la clave) en sus logs.
    assert.ok((README.match(/con npx, nunca `--api-key`/gi)?.length ?? 0) >= 2);
    assert.match(README, /no matches found/);
    // El «¿Desea terminar el trabajo por lotes?» también sale con npx, desde PowerShell.
    assert.doesNotMatch(README, /En PowerShell no aparece/);
    assert.match(README, /si corrés con `npx` o desde `cmd\.exe`/i);
    // Con NODE_USE_ENV_PROXY, Node sí usa el proxy: el README no afirma lo contrario.
    assert.doesNotMatch(README, /no cambian nada|no pasa por proxies/);
    assert.match(README, /no configura proxies por su cuenta/);
    assert.match(README, /NODE_TLS_REJECT_UNAUTHORIZED=0/);
    assert.match(README, /npx rayacash-cli@latest/);
    // El 130: un segundo Ctrl+C cuenta solo un segundo o más después del primero.
    assert.doesNotMatch(README, /dos veces seguidas/);
    const table = README.split("| Código | Cuándo |")[1]?.split("\n\n")[0] ?? "";
    for (const words of [
      /cuenta real/,
      /Node\.js/,
      /no está disponible/,
      /inesperado/,
      /un segundo o más después/,
    ]) {
      assert.match(table, words);
    }
  });
});
