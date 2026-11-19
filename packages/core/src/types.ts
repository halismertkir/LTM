import type { AudioSource, SegmentOrigin, SpeakerHint } from "@ltm/protocol";

/**
 * A piece of speech recognised from ONE stream of ONE device, with timestamps already
 * converted to the server clock (device time + estimated clock offset).
 */
export interface RawSegment {
  id: string;
  streamId: string;
  deviceId: string;
  source: AudioSource;
  origin: SegmentOrigin;
  startMs: number;
  endMs: number;
  text: string;
  /** 0..1, undefined when the recogniser gave none. */
  confidence?: number;
  language?: string;
  speaker?: SpeakerHint;
  /** Per-device override of SOURCE_PRIORITY (0..100). */
  devicePriority?: number | null;
}

/** One line of the canonical, de-duplicated transcript. */
export interface MergedUtterance {
  startMs: number;
  endMs: number;
  text: string;
  speaker: SpeakerHint;
  language?: string;
  origin: SegmentOrigin;
  /** Every raw segment folded into this utterance; the winner's segments come first. */
  segmentIds: string[];
  /** Devices that heard it; index 0 supplied the text. */
  deviceIds: string[];
  /** `sources[i]` is the source through which `deviceIds[i]` heard it (same length). */
  sources: AudioSource[];
}

export interface MergeOptions {
  /** Max clock disagreement between devices that is still treated as "the same moment". Default 2500. */
  clockToleranceMs?: number;
  /**
   * Minimum share (0..1) of the shorter text's tokens that must also appear, in order,
   * in the other text for two overlapping segments to count as the same speech. Default 0.6.
   */
  similarityThreshold?: number;
  /** Segments with fewer tokens than this are only matched when time overlap is strong. Default 3. */
  minTokensForLooseMatch?: number;
  /** Consecutive winner segments closer than this are joined into one utterance. Default 1200. */
  joinGapMs?: number;
  /** Upper bound for one joined utterance. Default 30000. */
  maxUtteranceMs?: number;
}

export interface ConversationSlice<T extends { startMs: number; endMs: number }> {
  startMs: number;
  endMs: number;
  items: T[];
}

export interface SplitOptions {
  /** Silence that ends a conversation. Default 5 minutes. */
  gapMs?: number;
  /** Hard cap; a longer session is cut at the longest pause near the cap. Default 4 hours. */
  maxDurationMs?: number;
}

/** A window of speech cut out of a continuous PCM stream. */
export interface SpeechWindow {
  /** Server-clock time of the first sample. */
  startMs: number;
  endMs: number;
  /** Mono signed 16-bit PCM at `sampleRate`. */
  pcm: Int16Array;
  sampleRate: number;
}

export interface SegmenterOptions {
  sampleRate: number;
  channels: number;
  /** Close the window after this much trailing silence. Default 700. */
  silenceMs?: number;
  /** Never emit windows longer than this (cut at the quietest point near the limit). Default 28000. */
  maxWindowMs?: number;
  /** Discard windows containing less speech than this. Default 300. */
  minSpeechMs?: number;
  /** Audio kept before the first speech frame. Default 250. */
  preRollMs?: number;
  /** A gap between frame timestamps larger than this forces the current window closed. Default 1500. */
  maxTimestampGapMs?: number;
}
