// Un receptor http o https en 127.0.0.1 que hace de «tu servidor local»: guarda los headers (en
// orden, crudos) y los bytes exactos de cada POST, y responde lo que el test diga.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { allowPort } from "./guard.ts";
import { tempDir } from "./helpers.ts";

export interface Hit {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** No responde nunca (para el timeout). */
  hang?: boolean;
  /** Manda los headers y después `body` en pedazos, sin terminar (para el tope de 64 KB). */
  stream?: boolean;
}

export interface Receiver {
  url: string;
  port: number;
  hits: Hit[];
  reply: (hit: Hit) => Reply;
  close(): Promise<void>;
}

export async function startReceiver(
  o: { tls?: { key: string; cert: string }; reply?: (hit: Hit) => Reply } = {},
): Promise<Receiver> {
  const hits: Hit[] = [];
  const receiver = { reply: o.reply ?? (() => ({ status: 200, body: "ok" })) } as Receiver;
  const handler = (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const hit: Hit = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks),
      };
      hits.push(hit);
      const reply = receiver.reply(hit);
      if (reply.hang) return;
      res.writeHead(reply.status ?? 200, reply.headers);
      if (reply.stream) {
        res.write(reply.body ?? "");
        return;
      }
      res.end(reply.body ?? "");
    });
  };
  const server: Server = o.tls
    ? createHttpsServer({ key: o.tls.key, cert: o.tls.cert }, handler)
    : createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  allowPort(port);
  receiver.url = `${o.tls ? "https" : "http"}://127.0.0.1:${port}`;
  receiver.port = port;
  receiver.hits = hits;
  receiver.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return receiver;
}

export interface Certs {
  /** Autofirmado para 127.0.0.1 y localhost. */
  selfSigned: { key: string; cert: string };
  /** Firmado por una CA propia (la de mkcert, Valet o Herd): Node no la conoce. */
  fromCa: { key: string; cert: string };
  /** El archivo PEM de esa CA (para NODE_EXTRA_CA_CERTS). */
  caFile: string;
}

let certs: Certs | null | undefined;

/** Certificados de prueba con openssl, o null si no hay openssl (los tests de TLS se saltean). */
export function testCerts(): Certs | null {
  if (certs !== undefined) return certs;
  try {
    const dir = tempDir();
    const file = (name: string) => path.join(dir, name);
    const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    writeFileSync(
      file("san.cnf"),
      "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n",
    );
    const subject = (cn: string) => ["-subj", `/CN=${cn}`];
    run([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      file("self.key"),
      "-out",
      file("self.pem"),
      ...subject("localhost"),
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ]);
    run([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      file("ca.key"),
      "-out",
      file("ca.pem"),
      ...subject("Raya test CA"),
    ]);
    run([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      file("leaf.key"),
      "-out",
      file("leaf.csr"),
      ...subject("localhost"),
    ]);
    run([
      "x509",
      "-req",
      "-in",
      file("leaf.csr"),
      "-CA",
      file("ca.pem"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-out",
      file("leaf.pem"),
      "-extfile",
      file("san.cnf"),
    ]);
    const read = (name: string) => readFileSync(file(name), "utf8");
    certs = {
      selfSigned: { key: read("self.key"), cert: read("self.pem") },
      fromCa: { key: read("leaf.key"), cert: read("leaf.pem") },
      caFile: file("ca.pem"),
    };
  } catch {
    certs = null;
  }
  return certs;
}
