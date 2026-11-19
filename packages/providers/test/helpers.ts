import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  json?: any;
  form?: FormData;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export async function startServer(
  handler: Handler,
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const rec: Recorded = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers: req.headers,
      body,
    };
    const type = req.headers["content-type"] ?? "";
    if (type.includes("application/json") && body.length)
      rec.json = JSON.parse(body.toString("utf8"));
    if (type.includes("multipart/form-data")) {
      rec.form = await new Request("http://x/", {
        method: "POST",
        headers: { "content-type": type },
        body,
      }).formData();
    }
    requests.push(rec);
    try {
      await handler(rec, res);
    } catch (e) {
      res.statusCode = 599;
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function chatReply(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "served-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
    ...extra,
  };
}
