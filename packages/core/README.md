# @ltm/core

Pure pipeline logic. No I/O, no dependencies besides `@ltm/protocol` types — everything
here is deterministic and unit-tested, and is what makes "several devices heard the same
thing" come out as one transcript. See `docs/ARCHITECTURE.md` for the reasoning.

## Public API

```ts
// text.ts — language-agnostic text comparison (Unicode aware; Turkish İ/ı safe)
normalizeText(text: string): string            // NFKC, lower-case, punctuation → space, collapse whitespace
tokenize(text: string): string[]               // tokens of normalizeText()
lcsLength(a: readonly string[], b: readonly string[]): number
containment(a: readonly string[], b: readonly string[]): number // lcsLength / min(len); 0 when either is empty
textSimilarity(a: string, b: string): number   // 2·lcs / (|a|+|b|) on tokens, 0..1

// merge.ts
mergeSegments(segments: RawSegment[], options?: MergeOptions): MergedUtterance[]

// conversations.ts
splitConversations<T extends { startMs: number; endMs: number }>(
  items: T[], options?: SplitOptions): ConversationSlice<T>[]

// segmenter.ts — energy VAD that cuts a continuous PCM stream into speech windows
class PcmSegmenter {
  constructor(options: SegmenterOptions)
  /** `pcm` is interleaved signed 16-bit LE as received in an audio frame. */
  push(pcm: Uint8Array, captureTimeMs: number, discontinuity?: boolean): SpeechWindow[]
  /** Emit whatever is buffered (stream ended). */
  flush(): SpeechWindow[]
}

// pcm.ts
bytesToInt16(bytes: Uint8Array): Int16Array                    // LE, copies when unaligned
downmixToMono(pcm: Int16Array, channels: number): Int16Array
resampleLinear(pcm: Int16Array, fromRate: number, toRate: number): Int16Array
rmsDbfs(pcm: Int16Array): number                               // -Infinity for silence
pcmToWav(pcm: Int16Array, sampleRate: number, channels?: number): Uint8Array
estimateClockOffsetMs(clientTimeMs: number, serverReceiveMs: number): number // server − client
```

Types (`RawSegment`, `MergedUtterance`, `MergeOptions`, `SpeechWindow`, …) are in
[`src/types.ts`](src/types.ts).
