import type { AddressInfo } from "node:net";
import {
  API_PREFIX,
  type AudioFrame,
  type ClientHello,
  decodeAudioFrame,
  PROTOCOL_VERSION,
  WS_INGEST_PATH,
  zClientMessage,
} from "@ltm/protocol";
import { type WebSocket, WebSocketServer } from "ws";

export interface ReceivedStream {
  hello: ClientHello;
  frames: AudioFrame[];
  transcripts: unknown[];
  ended: boolean;
  connections: number;
}

/**
 * A minimal ingest server following packages/protocol/src/ws.ts: hello → ready (resumed
 * when the streamId is known) → binary frames / ping→pong → end → closed.
 */
export class FakeIngestServer {
  readonly streams = new Map<string, ReceivedStream>();
  readonly errors: string[] = [];
  private wss!: WebSocketServer;
  private sockets = new Set<WebSocket>();
  /** Respond to the next hello with this fatal error instead of ready. */
  rejectNextHelloWith: string | null = null;
  /** Called for every decoded frame (lets tests kill the connection mid-stream). */
  onFrame: ((frame: AudioFrame, ws: WebSocket, stream: ReceivedStream) => void) | null = null;

  async start(): Promise<string> {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: `${API_PREFIX}${WS_INGEST_PATH}`,
    });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req.url ?? ""));
    await new Promise<void>((r) => this.wss.once("listening", () => r()));
    const { port } = this.wss.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  private onConnection(ws: WebSocket, url: string): void {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    if (/token|tok_/i.test(url)) this.errors.push(`credentials in URL: ${url}`);
    let stream: ReceivedStream | null = null;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!stream) {
          this.errors.push("binary frame before ready");
          return;
        }
        const buf = data as Buffer;
        try {
          const frame = decodeAudioFrame(
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice(),
          );
          stream.frames.push(frame);
          this.onFrame?.(frame, ws, stream);
        } catch (err) {
          this.errors.push(`bad frame: ${String(err)}`);
        }
        return;
      }
      const parsed = zClientMessage.safeParse(JSON.parse(String(data)));
      if (!parsed.success) {
        this.errors.push(`invalid client message: ${String(data).slice(0, 200)}`);
        return;
      }
      const msg = parsed.data;
      if (!stream && msg.type !== "hello") {
        this.errors.push(`${msg.type} before hello`);
        return;
      }
      switch (msg.type) {
        case "hello": {
          if (msg.protocol !== PROTOCOL_VERSION) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "unsupported_protocol",
                message: "",
                fatal: true,
              }),
            );
            ws.close(1000);
            return;
          }
          if (this.rejectNextHelloWith) {
            const code = this.rejectNextHelloWith;
            this.rejectNextHelloWith = null;
            ws.send(
              JSON.stringify({ type: "error", code, message: `refused: ${code}`, fatal: true }),
            );
            ws.close(4403);
            return;
          }
          const existing = this.streams.get(msg.streamId);
          stream = existing ?? {
            hello: msg,
            frames: [],
            transcripts: [],
            ended: false,
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
          return;
        }
        case "ping":
          ws.send(
            JSON.stringify({
              type: "pong",
              clientTimeMs: msg.clientTimeMs,
              serverTimeMs: Date.now(),
            }),
          );
          return;
        case "transcript":
          stream!.transcripts.push(...msg.segments);
          return;
        case "end":
          stream!.ended = true;
          ws.send(JSON.stringify({ type: "closed", streamId: stream!.hello.streamId }));
          return;
      }
    });
  }
}
