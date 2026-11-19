import { type AudioFrame, decodeAudioFrame } from "@ltm/protocol";
import type { WebSocketLike } from "../../src/stream/client.js";

/** Scriptable in-memory WebSocket: tests play the server side by hand. */
export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: Array<string | Uint8Array> = [];
  closedByClient: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static get last(): FakeSocket {
    const s = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!s) throw new Error("no socket created");
    return s;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("InvalidStateError: not open");
    if (typeof data === "string") this.sent.push(data);
    else if (ArrayBuffer.isView(data))
      this.sent.push(
        new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
      );
    else this.sent.push(new Uint8Array(data.slice(0)));
  }

  close(code?: number, reason?: string): void {
    const c: { code?: number; reason?: string } = {};
    if (code !== undefined) c.code = code;
    if (reason !== undefined) c.reason = reason;
    this.closedByClient = c;
    this.readyState = 3;
  }

  // ---- server side
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  get texts(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
  }

  get frames(): AudioFrame[] {
    return this.sent
      .filter((d): d is Uint8Array => typeof d !== "string")
      .map((d) => decodeAudioFrame(d));
  }

  /** Index in `sent` of the first binary message, or -1. */
  get firstBinaryIndex(): number {
    return this.sent.findIndex((d) => typeof d !== "string");
  }
}
