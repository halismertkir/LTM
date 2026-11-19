import { bytesToInt16, downmixToMono, resampleLinear, rmsDbfs } from "./pcm.js";
import type { SegmenterOptions, SpeechWindow } from "./types.js";

/** Sample rate of every emitted window (what speech recognisers expect). */
export const SEGMENTER_OUTPUT_RATE = 16000;

const FRAME_MS = 20;
/** A frame is speech when it is this far above the tracked noise floor… */
const START_DB_ABOVE_FLOOR = 10;
/** …or, once a window is open, this far (hysteresis keeps soft word endings in). */
const HOLD_DB_ABOVE_FLOOR = 6;
/** …and never below this absolute level, so a near-silent room cannot trigger windows. */
const ABS_MIN_SPEECH_DBFS = -55;
const DIGITAL_SILENCE_DBFS = -100;
const FLOOR_MIN_DBFS = -90;
const FLOOR_MAX_DBFS = -20;
/** Upper bound for the initial floor, so a stream that starts mid-sentence still opens a window. */
const INITIAL_FLOOR_MAX_DBFS = -35;
/** Per-frame smoothing of the floor: falls fast, rises slowly, barely rises during speech. */
const FLOOR_FALL = 0.15;
const FLOOR_RISE_SILENCE = 0.01;
const FLOOR_RISE_SPEECH = 0.002;
/** Trailing silence kept at the end of a window (recognisers like a little room). */
const TAIL_MS = 300;
/** Timestamp differences below this are clock jitter, not missing audio. */
const CONTIGUOUS_JITTER_MS = 30;
/** When a window hits maxWindowMs, the cut point is searched in this trailing span. */
const CUT_SEARCH_MS = 6000;
const CUT_SMOOTH_FRAMES = 2;

interface Frame {
  pcm: Int16Array;
  timeMs: number;
  durMs: number;
  db: number;
  speech: boolean;
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function spanMs(frames: Frame[]): number {
  if (frames.length === 0) return 0;
  const last = frames[frames.length - 1]!;
  return last.timeMs + last.durMs - frames[0]!.timeMs;
}

function speechMsOf(frames: Frame[]): number {
  let ms = 0;
  for (const f of frames) if (f.speech) ms += f.durMs;
  return ms;
}

/**
 * Energy VAD that cuts a continuous (or client-gated) PCM stream into speech windows.
 *
 * Frame timestamps are authoritative: each pushed buffer's `captureTimeMs` dates its
 * first sample. Short timestamp gaps (a client dropping silence) are filled with zeros
 * so that offsets inside a window stay aligned with wall-clock time; gaps longer than
 * `maxTimestampGapMs`, or an explicit discontinuity, close the current window.
 *
 * Memory is bounded by `maxWindowMs` of mono audio at the input rate plus the pre-roll.
 */
export class PcmSegmenter {
  private readonly rate: number;
  private readonly channels: number;
  private readonly frameLen: number;
  private readonly silenceMs: number;
  private readonly maxWindowMs: number;
  private readonly minSpeechMs: number;
  private readonly preRollMs: number;
  private readonly maxGapMs: number;

  private pending = new Int16Array(0);
  private pendingTimeMs = 0;
  private expectedNextMs: number | null = null;
  private floorDb: number | null = null;
  private preRoll: Frame[] = [];
  private window: Frame[] | null = null;
  private trailingSilenceMs = 0;

  constructor(options: SegmenterOptions) {
    if (!(options.sampleRate > 0)) throw new RangeError("sampleRate must be positive");
    if (!(options.channels >= 1)) throw new RangeError("channels must be at least 1");
    this.rate = options.sampleRate;
    this.channels = Math.floor(options.channels);
    this.frameLen = Math.max(1, Math.round((this.rate * FRAME_MS) / 1000));
    this.silenceMs = Math.max(FRAME_MS, options.silenceMs ?? 700);
    this.maxWindowMs = Math.max(1000, options.maxWindowMs ?? 28000);
    this.minSpeechMs = Math.max(0, options.minSpeechMs ?? 300);
    this.preRollMs = Math.max(0, options.preRollMs ?? 250);
    this.maxGapMs = Math.max(CONTIGUOUS_JITTER_MS, options.maxTimestampGapMs ?? 1500);
  }

  /** `pcm` is interleaved signed 16-bit LE as received in an audio frame. */
  push(pcm: Uint8Array, captureTimeMs: number, discontinuity = false): SpeechWindow[] {
    const out: SpeechWindow[] = [];
    const usable = pcm.byteLength - (pcm.byteLength % (2 * this.channels));
    const interleaved = bytesToInt16(pcm.subarray(0, usable));
    // The frame payload may be a view into a reused socket buffer: always own a copy.
    let samples =
      this.channels === 1 ? interleaved.slice() : downmixToMono(interleaved, this.channels);
    let time = Number.isFinite(captureTimeMs) ? captureTimeMs : (this.expectedNextMs ?? 0);

    if (this.expectedNextMs !== null) {
      const diff = time - this.expectedNextMs;
      if (discontinuity || Math.abs(diff) > this.maxGapMs) {
        this.breakStream(out);
      } else if (diff > CONTIGUOUS_JITTER_MS) {
        const zeros = new Int16Array(Math.round((diff * this.rate) / 1000));
        samples = concat(zeros, samples);
        time = this.expectedNextMs;
      }
    } else if (discontinuity) {
      this.breakStream(out);
    }
    if (samples.length === 0) return out;
    this.expectedNextMs = time + (samples.length * 1000) / this.rate;

    const pendLen = this.pending.length;
    const pendTime = this.pendingTimeMs;
    const all = concat(this.pending, samples);
    const timeAt = (k: number) =>
      k < pendLen ? pendTime + (k * 1000) / this.rate : time + ((k - pendLen) * 1000) / this.rate;
    let k = 0;
    for (; k + this.frameLen <= all.length; k += this.frameLen) {
      this.processFrame(all.slice(k, k + this.frameLen), timeAt(k), out);
    }
    this.pending = all.slice(k);
    this.pendingTimeMs = timeAt(k);
    return out;
  }

  /** Emit whatever is buffered (stream ended). */
  flush(): SpeechWindow[] {
    const out: SpeechWindow[] = [];
    if (this.pending.length > 0 && this.window) {
      this.processFrame(this.pending, this.pendingTimeMs, out);
    }
    this.breakStream(out);
    this.expectedNextMs = null;
    return out;
  }

  private breakStream(out: SpeechWindow[]): void {
    if (this.window) this.emit(this.window, true, out);
    this.window = null;
    this.trailingSilenceMs = 0;
    this.preRoll = [];
    this.pending = new Int16Array(0);
  }

  private processFrame(pcm: Int16Array, timeMs: number, out: SpeechWindow[]): void {
    const raw = rmsDbfs(pcm);
    const db = Number.isFinite(raw) ? Math.max(raw, DIGITAL_SILENCE_DBFS) : DIGITAL_SILENCE_DBFS;
    if (this.floorDb === null) {
      this.floorDb = Math.min(INITIAL_FLOOR_MAX_DBFS, Math.max(FLOOR_MIN_DBFS, db));
    }
    const above = this.window ? HOLD_DB_ABOVE_FLOOR : START_DB_ABOVE_FLOOR;
    const speech = db > Math.max(this.floorDb + above, ABS_MIN_SPEECH_DBFS);
    const rate = db < this.floorDb ? FLOOR_FALL : speech ? FLOOR_RISE_SPEECH : FLOOR_RISE_SILENCE;
    this.floorDb = Math.min(
      FLOOR_MAX_DBFS,
      Math.max(FLOOR_MIN_DBFS, this.floorDb + (db - this.floorDb) * rate),
    );

    const frame: Frame = { pcm, timeMs, durMs: (pcm.length * 1000) / this.rate, db, speech };

    if (!this.window) {
      if (speech) {
        this.window = [...this.preRoll, frame];
        this.preRoll = [];
        this.trailingSilenceMs = 0;
      } else {
        this.pushPreRoll([frame]);
      }
      return;
    }

    if (spanMs(this.window) + frame.durMs > this.maxWindowMs) this.cutAtQuietest(out);
    this.window.push(frame);
    this.trailingSilenceMs = speech ? 0 : this.trailingSilenceMs + frame.durMs;
    if (this.trailingSilenceMs >= this.silenceMs) {
      const frames = this.window;
      let lastSpeech = frames.length - 1;
      while (lastSpeech > 0 && !frames[lastSpeech]!.speech) lastSpeech--;
      const s = frames[lastSpeech]!;
      const keepUntil = s.timeMs + s.durMs + TAIL_MS;
      let end = lastSpeech + 1;
      while (end < frames.length && frames[end]!.timeMs + frames[end]!.durMs <= keepUntil) end++;
      this.emit(frames.slice(0, end), false, out);
      this.window = null;
      this.trailingSilenceMs = 0;
      this.preRoll = [];
      this.pushPreRoll(frames.slice(end));
    }
  }

  private pushPreRoll(frames: Frame[]): void {
    for (const f of frames) this.preRoll.push(f);
    let total = 0;
    for (const f of this.preRoll) total += f.durMs;
    while (this.preRoll.length > 0 && total > this.preRollMs + 1e-6) {
      total -= this.preRoll.shift()!.durMs;
    }
  }

  /** Splits an over-long window at its quietest recent moment; the rest stays open. */
  private cutAtQuietest(out: SpeechWindow[]): void {
    const frames = this.window!;
    const start = frames[0]!.timeMs;
    const total = spanMs(frames);
    const searchFrom = Math.max(this.maxWindowMs * 0.5, total - CUT_SEARCH_MS);
    let best = frames.length - 1;
    let bestDb = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      if (f.timeMs + f.durMs - start < searchFrom) continue;
      let sum = 0;
      let n = 0;
      for (let j = i - CUT_SMOOTH_FRAMES; j <= i + CUT_SMOOTH_FRAMES; j++) {
        const g = frames[j];
        if (g) {
          sum += g.db;
          n++;
        }
      }
      const db = sum / n;
      if (db <= bestDb) {
        bestDb = db;
        best = i;
      }
    }
    this.emit(frames.slice(0, best + 1), true, out);
    const rest = frames.slice(best + 1);
    this.window = rest;
    let trailing = 0;
    for (let i = rest.length - 1; i >= 0 && !rest[i]!.speech; i--) trailing += rest[i]!.durMs;
    this.trailingSilenceMs = trailing;
  }

  private emit(frames: Frame[], trimTail: boolean, out: SpeechWindow[]): void {
    let list = frames;
    if (trimTail) {
      let lastSpeech = list.length - 1;
      while (lastSpeech >= 0 && !list[lastSpeech]!.speech) lastSpeech--;
      if (lastSpeech < 0) return;
      const s = list[lastSpeech]!;
      const keepUntil = s.timeMs + s.durMs + TAIL_MS;
      let end = lastSpeech + 1;
      while (end < list.length && list[end]!.timeMs + list[end]!.durMs <= keepUntil) end++;
      list = list.slice(0, end);
    }
    if (list.length === 0 || speechMsOf(list) < this.minSpeechMs) return;
    let n = 0;
    for (const f of list) n += f.pcm.length;
    const mono = new Int16Array(n);
    let o = 0;
    for (const f of list) {
      mono.set(f.pcm, o);
      o += f.pcm.length;
    }
    const pcm =
      this.rate === SEGMENTER_OUTPUT_RATE
        ? mono
        : resampleLinear(mono, this.rate, SEGMENTER_OUTPUT_RATE);
    const last = list[list.length - 1]!;
    out.push({
      startMs: Math.round(list[0]!.timeMs),
      endMs: Math.round(last.timeMs + last.durMs),
      pcm,
      sampleRate: SEGMENTER_OUTPUT_RATE,
    });
  }
}
