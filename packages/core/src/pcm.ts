const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Interprets bytes as signed 16-bit little-endian samples. Returns a view sharing the
 * memory when alignment and host endianness allow it, otherwise a copy. A trailing odd
 * byte is ignored.
 */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1;
  if (LITTLE_ENDIAN && bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, n);
  }
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Signed 16-bit little-endian bytes (always a copy). */
export function int16ToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  return out;
}

/** Averages interleaved channels. With one channel the input is returned as is. */
export function downmixToMono(pcm: Int16Array, channels: number): Int16Array {
  const ch = Math.max(1, Math.floor(channels));
  if (ch === 1) return pcm;
  const frames = Math.floor(pcm.length / ch);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * ch;
    for (let c = 0; c < ch; c++) sum += pcm[base + c]!;
    out[f] = Math.round(sum / ch);
  }
  return out;
}

/**
 * Sample-rate conversion for speech. Upsampling interpolates linearly; downsampling
 * averages the input samples that fall into each output period (a box filter), which
 * suppresses most of the aliasing plain linear interpolation would fold into the speech
 * band — enough for VAD and speech recognition, not meant for music.
 */
export function resampleLinear(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("sample rates must be positive");
  if (fromRate === toRate || pcm.length === 0) return pcm.slice();
  const outLen = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const step = fromRate / toRate;
  const last = pcm.length - 1;
  if (step <= 1) {
    for (let i = 0; i < outLen; i++) {
      const pos = i * step;
      const i0 = Math.min(last, Math.floor(pos));
      const i1 = Math.min(last, i0 + 1);
      const frac = pos - i0;
      out[i] = Math.round(pcm[i0]! * (1 - frac) + pcm[i1]! * frac);
    }
    return out;
  }
  for (let i = 0; i < outLen; i++) {
    const from = Math.floor(i * step);
    const to = Math.min(pcm.length, Math.max(from + 1, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += pcm[Math.min(last, j)]!;
    out[i] = Math.round(sum / (to - from));
  }
  return out;
}

/** RMS level relative to full scale; -Infinity for digital silence or no samples. */
export function rmsDbfs(pcm: Int16Array): number {
  if (pcm.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!;
    sum += v * v;
  }
  if (sum === 0) return -Infinity;
  return 20 * Math.log10(Math.sqrt(sum / pcm.length) / 32768);
}

export const WAV_HEADER_BYTES = 44;

/** Canonical 44-byte RIFF/WAVE (PCM, 16-bit) file. */
export function pcmToWav(pcm: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  const blockAlign = channels * 2;
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true); // byte rate
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i]!, true);
  return out;
}

/**
 * Offset to add to a device timestamp to get server time. Network latency is ignored on
 * purpose: it is far below the merge tolerance and unknowable from a single message.
 */
export function estimateClockOffsetMs(clientTimeMs: number, serverReceiveMs: number): number {
  return serverReceiveMs - clientTimeMs;
}
