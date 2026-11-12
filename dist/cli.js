#!/usr/bin/env node
// El bin (`rayacash` y `rayacash-cli`). Lo mínimo para que un Node viejo muestre el mensaje y no
// un error de sintaxis o de link: ningún import estático (main.ts usa APIs de Node 22) y nada que
// un Node viejo no entienda.
const node = process.versions.node;
if (Number.parseInt(node, 10) < 22) {
    process.stderr.write(`rayacash-cli necesita Node.js 22 o más nuevo (tenés ${node}).\n`);
    process.exitCode = 1;
}
else {
    import("./main.js")
        .then((main) => main.run())
        .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
export {};
