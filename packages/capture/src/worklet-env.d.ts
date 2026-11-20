// Minimal AudioWorkletGlobalScope declarations: TypeScript ships no "AudioWorklet" lib, and
// pulling in DOM here would hide mistakes such as using `window` in the realtime thread.

interface AudioWorkletMessagePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

type Transferable = ArrayBuffer;

declare abstract class AudioWorkletProcessor {
  readonly port: AudioWorkletMessagePort;
  constructor(options?: { processorOptions?: unknown });
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
