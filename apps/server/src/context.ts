import type { ServerSegment } from "@ltm/protocol";
import type { SecretBox } from "./crypto.js";
import type { Deps, EventBus } from "./deps.js";
import type { JobQueue } from "./pipeline/jobs.js";
import type { AudioStore } from "./services/audio-store.js";

/** What the job pipeline needs to know about live ingest sockets. */
export interface LiveIngest {
  /** Echo a recognised segment to the socket carrying `streamId`, if connected. */
  sendSegment(streamId: string, message: ServerSegment): void;
  /** Closes every ingest socket of the user (kill switch, consent withdrawn, account deleted). */
  refuseUser(
    userId: string,
    code: "consent_required" | "ingest_paused" | "unauthorized",
    message: string,
  ): void;
  /** Closes the sockets of one device (device revoked). */
  dropDevice(deviceId: string): void;
  isStreamConnected(streamId: string): boolean;
  connectedDeviceIds(userId: string): Set<string>;
}

/** Deps plus the process-wide services built on top of them. */
export interface Ctx extends Deps {
  bus: EventBus;
  secrets: SecretBox;
  audio: AudioStore;
  jobs: JobQueue;
  live: LiveIngest;
}

export const noLiveIngest: LiveIngest = {
  sendSegment() {},
  refuseUser() {},
  dropDevice() {},
  isStreamConnected: () => false,
  connectedDeviceIds: () => new Set(),
};

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}
