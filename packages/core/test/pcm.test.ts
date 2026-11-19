import { describe, expect, it } from "vitest";
import {
  bytesToInt16,
  downmixToMono,
  estimateClockOffsetMs,
  int16ToBytes,
  pcmToWav,
  resampleLinear,
  rmsDbfs,
} from "../src/index.js";

describe("pcm helpers", () => {
  it("bytesToInt16 reads little-endian, aligned or not", () => {
    const bytes = new Uint8Array([0x01, 0x00, 0xff, 0xff, 0x00, 0x80]);
    expect([...bytesToInt16(bytes)]).toEqual([1, -1, -32768]);
    const unaligned = new Uint8Array(7);
    unaligned.set(bytes, 1);
    expect([...bytesToInt16(unaligned.subarray(1))]).toEqual([1, -1, -32768]);
    expect(bytesToInt16(new Uint8Array(3))).toHaveLength(1);
  });

  it("int16ToBytes round-trips", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    expect([...bytesToInt16(int16ToBytes(pcm))]).toEqual([...pcm]);
  });

  it("downmixes interleaved channels", () => {
    expect([...downmixToMono(new Int16Array([100, 200, -100, -300]), 2)]).toEqual([150, -200]);
    const mono = new Int16Array([1, 2]);
    expect(downmixToMono(mono, 1)).toBe(mono);
  });

  it("resamples with the right length and preserves a DC level", () => {
    const dc = new Int16Array(4800).fill(1000);
    const down = resampleLinear(dc, 48000, 16000);
    expect(down).toHaveLength(1600);
    expect(down.every((v) => v === 1000)).toBe(true);
    const up = resampleLinear(new Int16Array(800).fill(-500), 8000, 16000);
    expect(up).toHaveLength(1600);
    expect(up.every((v) => v === -500)).toBe(true);
    expect(resampleLinear(new Int16Array([0, 100]), 8000, 16000)[1]).toBe(50);
  });

  it("attenuates content above the new Nyquist frequency when downsampling", () => {
    const n = 4800;
    const tone = new Int16Array(n);
    for (let i = 0; i < n; i++)
      tone[i] = Math.round(10000 * Math.sin((2 * Math.PI * 12000 * i) / 48000));
    const down = resampleLinear(tone, 48000, 16000);
    expect(rmsDbfs(down)).toBeLessThan(rmsDbfs(tone) - 6);
  });

  it("computes dBFS", () => {
    expect(rmsDbfs(new Int16Array(100))).toBe(-Infinity);
    expect(rmsDbfs(new Int16Array(0))).toBe(-Infinity);
    expect(rmsDbfs(new Int16Array(100).fill(-32768))).toBeCloseTo(0, 5);
    expect(rmsDbfs(new Int16Array(100).fill(3277))).toBeCloseTo(-20, 1);
  });

  it("writes a canonical 44-byte WAV header", () => {
    const pcm = new Int16Array([1, -2, 3]);
    const wav = pcmToWav(pcm, 16000);
    expect(wav.byteLength).toBe(44 + 6);
    const v = new DataView(wav.buffer);
    const ascii = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(6);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([1, -2, 3]);

    const stereo = new DataView(pcmToWav(new Int16Array(4), 48000, 2).buffer);
    expect(stereo.getUint16(22, true)).toBe(2);
    expect(stereo.getUint32(28, true)).toBe(48000 * 4);
    expect(stereo.getUint16(32, true)).toBe(4);
  });

  it("estimates the clock offset as server minus client", () => {
    expect(estimateClockOffsetMs(1000, 4000)).toBe(3000);
    expect(estimateClockOffsetMs(5000, 4000)).toBe(-1000);
  });
});
