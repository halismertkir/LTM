/**
 * A fake ingest WebSocket endpoint for the smoke run: speaks the handshake in
 * packages/protocol/src/ws.ts, validates every client message with the protocol schemas
 * and decodes the binary audio frames, so "listen with this device" is checked end to end
 * with real frames from Chromium's fake microphone.
 */
import {
  decodeAudioFrame,
  type ServerMessage,
  zClientMessage,
  zServerMessage,
} from "@ltm/protocol";

export interface IngestStats {
  hellos: { token: string; source: string; mode: string; streamId: string; sampleRate?: number }[];
  frames: number;
  audioMs: number;
  lastSeq: number;
  ends: number;
  errors: string[];
}

export class FakeIngest {
  stats: IngestStats = { hellos: [], frames: 0, audioMs: 0, lastSeq: -1, ends: 0, errors: [] };
  /** Expected device token; anything else gets `unauthorized`. */
  constructor(private readonly validTokens: () => string[]) {}

  /** Handle one client message; returns the server messages to send back. */
  receive(message: string | Uint8Array): ServerMessage[] {
    if (typeof message !== "string") {
      try {
        const f = decodeAudioFrame(message);
        this.stats.frames++;
        this.stats.lastSeq = f.seq;
        this.stats.audioMs += (f.payload.byteLength / 2 / 16_000) * 1000;
        // Echo a "recognised" caption every 10 frames, like the server's live feedback.
        if (this.stats.frames % 10 === 0) {
          return this.out({
            type: "segment",
            segment: {
              id: `fake-${this.stats.frames}`,
              startMs: f.captureTimeMs,
              endMs: f.captureTimeMs + 2000,
              text: `Caption ${this.stats.frames / 10} from the fake recogniser.`,
              origin: "server_stt",
            },
          });
        }
      } catch (e) {
        this.stats.errors.push(`bad frame: ${e instanceof Error ? e.message : e}`);
      }
      return [];
    }
    const parsed = zClientMessage.safeParse(JSON.parse(message));
    if (!parsed.success) {
      this.stats.errors.push(`bad message: ${parsed.error.message}`);
      return this.out({
        type: "error",
        code: "bad_request",
        message: "invalid message",
        fatal: true,
      });
    }
    const m = parsed.data;
    if (m.type === "hello") {
      this.stats.hellos.push({
        token: m.token,
        source: m.source,
        mode: m.mode,
        streamId: m.streamId,
        sampleRate: m.audio?.sampleRate,
      });
      if (!this.validTokens().includes(m.token)) {
        return this.out({
          type: "error",
          code: "unauthorized",
          message: "unknown device",
          fatal: true,
        });
      }
      return this.out({
        type: "ready",
        streamId: m.streamId,
        serverTimeMs: Date.now(),
        resumed: false,
      });
    }
    if (m.type === "ping")
      return this.out({ type: "pong", clientTimeMs: m.clientTimeMs, serverTimeMs: Date.now() });
    if (m.type === "end") {
      this.stats.ends++;
      const id = this.stats.hellos.at(-1)?.streamId;
      return id ? this.out({ type: "closed", streamId: id }) : [];
    }
    return [];
  }

  private out(...msgs: ServerMessage[]): ServerMessage[] {
    return msgs.map((x) => zServerMessage.parse(x));
  }
}
