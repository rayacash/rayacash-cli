// Una API falsa en 127.0.0.1 con POST /v1/test/webhooks/listen guionado: cada request toma la
// próxima respuesta de la cola; sin cola, responde una página vacía. Guarda cada request (headers y
// body) para que el test los mire. Con `tls`, habla https con ese certificado.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { allowPort } from "./guard.ts";

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: unknown;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Se serializa como JSON. */
  json?: unknown;
  /** El body tal cual (gana sobre json). */
  body?: string | Buffer;
  /** Espera antes de responder (para el timeout del sondeo). */
  delayMs?: number;
}

export type Script = FakeResponse | ((request: FakeRequest) => FakeResponse);

export interface FakeApi {
  url: string;
  port: number;
  requests: FakeRequest[];
  enqueue(...responses: Script[]): void;
  close(): Promise<void>;
}

export const SANDBOX = { id: "sbx_9fKc2LmQ8rT1uVwXyZ0aBcDe", name: "Mi tienda" };
export const ALL_EVENTS = [
  "payment.created",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "connect.order.created",
  "connect.order.succeeded",
  "connect.order.failed",
  "connect.order.refunded",
];

/** Una página 200 con los defaults del contrato. */
export function page(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "webhook_listen",
    sandbox: SANDBOX,
    events: ALL_EVENTS,
    data: [],
    has_more: false,
    cursor: "c1",
    gap: false,
    poll_interval_ms: 1000,
    ...over,
  };
}

/** El envelope de error de la API. */
export function apiError(
  status: number,
  code: string,
  message: string,
  data: unknown = null,
  headers: Record<string, string> = {},
): FakeResponse {
  return { status, headers, json: { error: { code, message, data } } };
}

export async function startFakeApi(
  fallback: Script = { json: page() },
  o: { tls?: { key: string; cert: string } } = {},
): Promise<FakeApi> {
  const queue: Script[] = [];
  const requests: FakeRequest[] = [];
  const handler = (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const request: FakeRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
        json,
      };
      requests.push(request);
      const script = queue.shift() ?? fallback;
      const response = typeof script === "function" ? script(request) : script;
      const send = () => {
        if (res.destroyed) return;
        const payload =
          response.body ?? (response.json === undefined ? "" : JSON.stringify(response.json));
        res.writeHead(response.status ?? 200, {
          "Content-Type": response.body === undefined ? "application/json" : "text/html",
          ...response.headers,
        });
        res.end(payload);
      };
      if (response.delayMs) setTimeout(send, response.delayMs);
      else send();
    });
  };
  const server: Server = o.tls
    ? createHttpsServer({ key: o.tls.key, cert: o.tls.cert }, handler)
    : createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  allowPort(port);
  return {
    url: `${o.tls ? "https" : "http"}://127.0.0.1:${port}`,
    port,
    requests,
    enqueue: (...responses) => queue.push(...responses),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
