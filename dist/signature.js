// La firma de Raya-Signature, la misma de las entregas reales: HMAC-SHA256 con el secreto entero
// (whsec_… en UTF-8) sobre "<t>." + los bytes exactos del body, en hex minúscula.
import { createHmac } from "node:crypto";
export function sign(secret, timestamp, body) {
    return createHmac("sha256", Buffer.from(secret, "utf8"))
        .update(`${timestamp}.`, "ascii")
        .update(body)
        .digest("hex");
}
/** `t=<t>,v1=<hex>`, con un solo v1. */
export function signatureHeader(secret, timestamp, body) {
    return `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
}
