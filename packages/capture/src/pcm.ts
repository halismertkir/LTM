/** Float [-1, 1] → signed 16-bit with clipping. NaN (a broken source) becomes silence. */
export function floatToS16(input: Float32Array, out = new Int16Array(input.length)): Int16Array {
  for (let i = 0; i < input.length; i++) {
    let x = input[i]!;
    if (Number.isNaN(x)) x = 0;
    if (x > 1) x = 1;
    else if (x < -1) x = -1;
    // Asymmetric scale so that -1 → -32768 and +1 → 32767 without overflow.
    out[i] = Math.round(x < 0 ? x * 32768 : x * 32767);
  }
  return out;
}

/** Averages all channels into `out`. Averaging (not summing) cannot clip. */
export function downmixToMono(channels: readonly Float32Array[], out: Float32Array): Float32Array {
  const n = channels[0]?.length ?? 0;
  const count = channels.length;
  if (count === 0) {
    out.fill(0, 0, n);
    return out.subarray(0, n);
  }
  if (count === 1) {
    out.set(channels[0]!);
    return out.subarray(0, n);
  }
  const scale = 1 / count;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < count; c++) s += channels[c]![i]!;
    out[i] = s * scale;
  }
  return out.subarray(0, n);
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * The wire format is little-endian. Every platform Chrome runs on is little-endian, so
 * this is normally a zero-copy view; the swap branch exists so the codec is never wrong.
 */
export function s16ToLeBytes(pcm: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  return out;
}

export function leBytesToS16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** RMS level in dBFS (0 dB = full-scale square wave); −120 for digital silence. */
export function rmsDbfs(pcm: Int16Array): number {
  if (pcm.length === 0) return -120;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / pcm.length);
  return rms > 1e-6 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}
