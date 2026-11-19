import { rmsDbfs } from "./pcm.js";

export interface StampedBlock {
  pcm: Int16Array;
  /** Device-clock epoch ms of the first sample. */
  captureTimeMs: number;
  discontinuity: boolean;
}

export interface GateOptions {
  /** Duration of one block in ms (all blocks are the same length). */
  blockMs: number;
  /** Keep sending this long after the level drops below the threshold. ≥ 500 ms. */
  hangoverMs?: number;
  /** Blocks of audio kept from before the gate opened, so word onsets are not clipped. */
  preRollMs?: number;
  /** Never treat anything above this as silence, whatever the noise floor. */
  maxThresholdDb?: number;
  /** Anything below this is silence, whatever the noise floor. */
  minThresholdDb?: number;
  /** How far above the tracked noise floor a block must be to open the gate. */
  marginDb?: number;
}

/**
 * Light energy gate. Long silence (muted meetings, an empty room) is not uploaded; the
 * server's own VAD does the real speech segmentation, so this errs on the side of letting
 * audio through: a generous hangover, some pre-roll, and a threshold that tracks the noise
 * floor but is capped so that normal speech always passes.
 *
 * Gated blocks are simply not sent. Because every frame carries its own capture
 * timestamp the server does not lose time; the first frame after a gap carries the
 * DISCONTINUITY flag so it does not glue the two sides together.
 */
export class EnergyGate {
  private readonly hangoverBlocks: number;
  private readonly preRollBlocks: number;
  private readonly maxThr: number;
  private readonly minThr: number;
  private readonly margin: number;
  private readonly floorRisePerBlock: number;

  private open = false;
  private hangLeft = 0;
  private preRoll: StampedBlock[] = [];
  /** True once at least one block was withheld since the last one we emitted. */
  private gapped = false;
  private floorDb = -90;
  private seenAny = false;

  constructor(opts: GateOptions) {
    const blockMs = opts.blockMs;
    this.hangoverBlocks = Math.ceil(Math.max(500, opts.hangoverMs ?? 800) / blockMs);
    this.preRollBlocks = Math.ceil((opts.preRollMs ?? 400) / blockMs);
    this.maxThr = opts.maxThresholdDb ?? -40;
    this.minThr = opts.minThresholdDb ?? -62;
    this.margin = opts.marginDb ?? 10;
    // The floor follows quieter levels immediately and rises by ~3 dB/s, so a steady fan
    // is learned within seconds while a long sentence does not lift the floor much.
    this.floorRisePerBlock = (3 * blockMs) / 1000;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get noiseFloorDb(): number {
    return this.floorDb;
  }

  get thresholdDb(): number {
    return Math.min(this.maxThr, Math.max(this.minThr, this.floorDb + this.margin));
  }

  /** Feeds one block; returns the blocks to send now (0, 1, or pre-roll + this one). */
  push(block: StampedBlock): StampedBlock[] {
    const level = rmsDbfs(block.pcm);
    // The very first block seeds the floor before it is judged (so steady noise does not
    // pass until the floor is learned); afterwards a block is judged against the floor
    // *before* it moves it, so loud speech cannot raise its own threshold.
    const first = !this.seenAny;
    if (first) this.trackFloor(level);
    const threshold = this.thresholdDb;
    if (!first) this.trackFloor(level);
    // A discontinuity reported upstream must survive gating: if this block is dropped the
    // flag moves to the next block we do send.
    if (block.discontinuity) this.gapped = true;

    if (level >= threshold) {
      this.hangLeft = this.hangoverBlocks;
      if (!this.open) {
        this.open = true;
        const out = [...this.preRoll, block];
        this.preRoll = [];
        return this.emit(out);
      }
      return this.emit([block]);
    }

    if (this.open) {
      this.hangLeft--;
      if (this.hangLeft <= 0) this.open = false;
      return this.emit([block]);
    }

    // Closed: remember the block as potential pre-roll.
    this.preRoll.push(block);
    if (this.preRoll.length > this.preRollBlocks) {
      this.preRoll.shift();
      this.gapped = true;
    }
    return [];
  }

  /** Forget pending pre-roll (e.g. on stop) and start the next block with a discontinuity. */
  reset(): void {
    this.open = false;
    this.hangLeft = 0;
    this.preRoll = [];
    this.gapped = true;
  }

  private emit(blocks: StampedBlock[]): StampedBlock[] {
    if (blocks.length === 0) return blocks;
    if (this.gapped) {
      blocks[0] = { ...blocks[0]!, discontinuity: true };
      this.gapped = false;
    }
    return blocks;
  }

  private trackFloor(level: number): void {
    if (!this.seenAny) {
      this.seenAny = true;
      this.floorDb = Math.max(-90, Math.min(level, this.maxThr - this.margin));
      return;
    }
    if (level < this.floorDb) this.floorDb = Math.max(-90, level);
    else this.floorDb = Math.min(this.floorDb + this.floorRisePerBlock, level);
  }
}
