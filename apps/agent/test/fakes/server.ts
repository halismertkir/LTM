import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type AudioFrame, type ClientHello, decodeAudioFrame, zClientMessage } from "@ltm/protocol";
import { WebSocketServer } from "ws";

export interface FakeStream {
  hello: ClientHello;
  frames: Array<AudioFrame & { receivedAt: number }>;
  ended: boolean;
  closedSent: boolean;
  connections: number;
}

/** REST (/version, /devices/pair, /me, /consents) + ingest WebSocket, per the protocol. */
export class FakeLtm {
  readonly token = "tok_agent_test_0123456789abcdef";
  consent: Record<string, boolean> = { recording_responsibility: false, data_processing: false };
  ingestPaused = false;
  readonly streams = new Map<string, FakeStream>();
  readonly errors: string[] = [];
  readonly requests: string[] = [];
  pairCodes = new Set(["GOOD-CODE"]);
  private http!: Server;
  private wss!: WebSocketServer;
  url = "";

  async start(): Promise<string> {
    this.http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () =>
        this.handle(req.method ?? "GET", req.url ?? "", req.headers.authorization, body, res),
      );
    });
    this.wss = new WebSocketServer({ server: this.http, path: "/api/v1/ingest/ws" });
    this.wss.on("connection", (ws, req) => {
      if (/tok_/.test(req.url ?? "")) this.errors.push("token in URL");
      let stream: FakeStream | null = null;
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          if (!stream) return void this.errors.push("frame before ready");
          const b = data as Buffer;
          try {
            const f = decodeAudioFrame(
              new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(),
            );
            stream.frames.push({ ...f, receivedAt: Date.now() });
          } catch (err) {
            this.errors.push(`bad frame ${String(err)}`);
          }
          return;
        }
        const parsed = zClientMessage.safeParse(JSON.parse(String(data)));
        if (!parsed.success)
          return void this.errors.push(`invalid message ${String(data).slice(0, 120)}`);
        const msg = parsed.data;
        if (msg.type === "hello") {
          if (msg.token !== this.token) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "unauthorized",
                message: "bad token",
                fatal: true,
              }),
            );
            ws.close(4401);
            return;
          }
          if (!this.consentSatisfied()) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "consent_required",
                message: "accept consent",
                fatal: true,
              }),
            );
            ws.close(4403);
            return;
          }
          const existing = this.streams.get(msg.streamId);
          stream = existing ?? {
            hello: msg,
            frames: [],
            ended: false,
            closedSent: false,
            connections: 0,
          };
          stream.connections++;
          this.streams.set(msg.streamId, stream);
          ws.send(
            JSON.stringify({
              type: "ready",
              streamId: msg.streamId,
              serverTimeMs: Date.now(),
              resumed: !!existing,
            }),
          );
          if (!existing) {
            setTimeout(() => {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "segment",
                    segment: {
                      startMs: Date.now() - 500,
                      endMs: Date.now(),
                      text: "fake caption line",
                      origin: "server_stt",
                    },
                  }),
                );
              }
            }, 300);
          }
        } else if (msg.type === "ping") {
          ws.send(
            JSON.stringify({
              type: "pong",
              clientTimeMs: msg.clientTimeMs,
              serverTimeMs: Date.now(),
            }),
          );
        } else if (msg.type === "end" && stream) {
          stream.ended = true;
          stream.closedSent = true;
          ws.send(JSON.stringify({ type: "closed", streamId: stream.hello.streamId }));
        }
      });
    });
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  consentSatisfied(): boolean {
    return Object.values(this.consent).every(Boolean);
  }

  private consentState() {
    const required = Object.entries(this.consent).map(([type, accepted]) => ({
      type,
      version: "2026-11-19",
      accepted,
    }));
    return { satisfied: this.consentSatisfied(), required, records: [] };
  }

  private handle(
    method: string,
    url: string,
    auth: string | undefined,
    body: string,
    res: import("node:http").ServerResponse,
  ) {
    this.requests.push(`${method} ${url}`);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url === "/api/v1/version")
      return send(200, { name: "ltm", version: "0.0.0-test", protocol: 1 });
    const device = {
      id: "dev-agent",
      name: "ltm-agent test",
      kind: "desktop",
      access: "capture",
      platform: "linux x64",
      appVersion: "0.1.0",
      priority: null,
      createdAt: "2026-11-20T00:00:00.000Z",
      lastSeenAt: null,
      online: false,
    };
    if (url === "/api/v1/devices/pair" && method === "POST") {
      const req = JSON.parse(body);
      if (!this.pairCodes.has(req.code))
        return send(404, { error: { code: "not_found", message: "unknown code" } });
      if (req.kind !== "desktop")
        return send(400, { error: { code: "bad_request", message: "kind" } });
      this.pairCodes.delete(req.code);
      return send(200, {
        device: { ...device, name: req.name },
        token: this.token,
        user: { id: "u1", displayName: "Owner", locale: "en" },
      });
    }
    if (auth !== `Bearer ${this.token}`)
      return send(401, { error: { code: "unauthorized", message: "bad token" } });
    if (url === "/api/v1/me") {
      return send(200, {
        user: {
          id: "u1",
          email: "owner@example.test",
          displayName: "Owner",
          role: "owner",
          locale: "en",
          createdAt: "2026-11-20T00:00:00.000Z",
        },
        principal: { type: "device", deviceId: "dev-agent" },
        consent: this.consentState(),
        ingestPaused: this.ingestPaused,
      });
    }
    if (url === "/api/v1/devices/self") return send(200, device);
    if (url === "/api/v1/consents" && method === "POST") {
      for (const a of JSON.parse(body).accept)
        if (a.version === "2026-11-19") this.consent[a.type] = true;
      return send(200, this.consentState());
    }
    send(404, { error: { code: "not_found", message: url } });
  }
}
