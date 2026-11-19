import { describe, expect, it } from "vitest";
import {
  CONSENT_DOCUMENTS,
  decodeAudioFrame,
  encodeAudioFrame,
  FRAME_HEADER_BYTES,
  FrameError,
  NOTICE_TEMPLATES,
  PROTOCOL_VERSION,
  requiredConsentDocuments,
  zClientMessage,
  zConsentType,
  zProviderConfigInput,
} from "../src/index.js";

describe("audio frames", () => {
  it("round-trips header fields and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const encoded = encodeAudioFrame({
      seq: 4_000_000_000,
      captureTimeMs: 1_763_000_000_123.5,
      discontinuity: true,
      payload,
    });
    expect(encoded.byteLength).toBe(FRAME_HEADER_BYTES + payload.byteLength);
    const decoded = decodeAudioFrame(encoded);
    expect(decoded.seq).toBe(4_000_000_000);
    expect(decoded.captureTimeMs).toBe(1_763_000_000_123.5);
    expect(decoded.discontinuity).toBe(true);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("decodes a frame that is a view into a larger buffer", () => {
    const frame = encodeAudioFrame({
      seq: 7,
      captureTimeMs: 1000,
      discontinuity: false,
      payload: new Uint8Array([9, 9]),
    });
    const big = new Uint8Array(frame.byteLength + 10);
    big.set(frame, 5);
    const decoded = decodeAudioFrame(big.subarray(5, 5 + frame.byteLength));
    expect(decoded.seq).toBe(7);
    expect(decoded.captureTimeMs).toBe(1000);
    expect(Array.from(decoded.payload)).toEqual([9, 9]);
  });

  it("rejects malformed frames", () => {
    expect(() => decodeAudioFrame(new Uint8Array(3))).toThrow(FrameError);
    const bad = encodeAudioFrame({
      seq: 0,
      captureTimeMs: 1,
      discontinuity: false,
      payload: new Uint8Array(2),
    });
    bad[0] = 0;
    expect(() => decodeAudioFrame(bad)).toThrow(/magic/);
    const badVersion = encodeAudioFrame({
      seq: 0,
      captureTimeMs: 1,
      discontinuity: false,
      payload: new Uint8Array(2),
    });
    badVersion[2] = 9;
    expect(() => decodeAudioFrame(badVersion)).toThrow(/version/);
  });
});

describe("client messages", () => {
  const hello = {
    type: "hello",
    protocol: PROTOCOL_VERSION,
    token: "x".repeat(32),
    streamId: "3f0e9c9e-4f2b-4d5e-9a57-0d2f5f0f6a11",
    source: "tab",
    mode: "audio",
    audio: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
    clientTimeMs: Date.now(),
  };

  it("accepts a valid hello", () => {
    expect(zClientMessage.parse(hello).type).toBe("hello");
  });

  it("rejects unknown sources and codecs", () => {
    expect(zClientMessage.safeParse({ ...hello, source: "satellite" }).success).toBe(false);
    expect(
      zClientMessage.safeParse({ ...hello, audio: { ...hello.audio, codec: "mp3" } }).success,
    ).toBe(false);
  });

  it("accepts edge transcripts", () => {
    const parsed = zClientMessage.parse({
      type: "transcript",
      segments: [
        { startMs: 1000, endMs: 2500, text: "merhaba dünya", confidence: 0.9, language: "tr" },
      ],
    });
    expect(parsed.type).toBe("transcript");
  });
});

describe("consent documents", () => {
  it("covers every consent type in both languages", () => {
    for (const type of zConsentType.options) {
      const doc = CONSENT_DOCUMENTS.find((d) => d.type === type);
      expect(doc, type).toBeDefined();
      for (const locale of ["en", "tr"] as const) {
        expect(doc![locale].title.length).toBeGreaterThan(5);
        expect(doc![locale].body.length).toBeGreaterThan(200);
      }
    }
    expect(NOTICE_TEMPLATES.spoken.tr).toContain("kaydeden");
  });

  it("requires third-party consent only for third-party providers", () => {
    const local = requiredConsentDocuments(["openai_compatible", "none"]).map((d) => d.type);
    expect(local).toEqual(["recording_responsibility", "data_processing"]);
    const cloud = requiredConsentDocuments(["anthropic", "openai_compatible"]).map((d) => d.type);
    expect(cloud).toContain("third_party_ai");
    expect(requiredConsentDocuments(["claude_code_cli"]).map((d) => d.type)).toContain(
      "third_party_ai",
    );
  });
});

describe("provider config input", () => {
  it("treats apiKey as optional / nullable write-only", () => {
    expect(zProviderConfigInput.parse({ kind: "anthropic", apiKey: "k" }).apiKey).toBe("k");
    expect(zProviderConfigInput.parse({ kind: "anthropic", apiKey: null }).apiKey).toBeNull();
    expect(
      zProviderConfigInput.parse({
        kind: "openai_compatible",
        baseUrl: "http://localhost:11434/v1",
      }).baseUrl,
    ).toBe("http://localhost:11434/v1");
    expect(zProviderConfigInput.safeParse({ kind: "bogus" }).success).toBe(false);
  });
});
