// La firma de Raya-Signature, la misma de las entregas reales: HMAC-SHA256 con el secreto entero
// (whsec_… en UTF-8) sobre "<t>." + los bytes exactos del body, en hex minúscula.

import { createHmac } from "node:crypto";

export function sign(secret: string, timestamp: number, body: Uint8Array): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${timestamp}.`, "ascii")
    .update(body)
    .digest("hex");
}

/** `t=<t>,v1=<hex>`, con un solo v1. */
export function signatureHeader(secret: string, timestamp: number, body: Uint8Array): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
}
