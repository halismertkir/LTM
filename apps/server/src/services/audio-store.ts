import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
const EXT_BY_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
};

function assertId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe ${kind} id for an audio path`);
}

/**
 * Transient audio under LTM_DATA_DIR/audio/<userId>/<streamId>/<chunkId>.<ext>.
 * Paths are built only from ids the server generated or validated as UUIDs, and are
 * re-checked to stay inside the root, so no client string can steer a file operation.
 */
export class AudioStore {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = resolve(dataDir, "audio");
  }

  relPath(userId: string, streamId: string, chunkId: string, mimeType: string): string {
    assertId("user", userId);
    assertId("stream", streamId);
    assertId("chunk", chunkId);
    const ext = EXT_BY_MIME[mimeType] ?? "bin";
    return join(userId, streamId, `${chunkId}.${ext}`);
  }

  private abs(rel: string): string {
    const p = resolve(this.root, rel);
    const r = relative(this.root, p);
    if (r === "" || r.startsWith("..") || isAbsolute(r))
      throw new Error("audio path escapes the audio root");
    return p;
  }

  async write(rel: string, data: Uint8Array): Promise<void> {
    const p = this.abs(rel);
    await mkdir(resolve(p, ".."), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode: 0o600 });
  }

  read(rel: string): Promise<Buffer> {
    return readFile(this.abs(rel));
  }

  async remove(rel: string): Promise<void> {
    await rm(this.abs(rel), { force: true });
  }

  async removeUser(userId: string): Promise<void> {
    assertId("user", userId);
    await rm(this.abs(userId), { recursive: true, force: true });
  }

  async removeStream(userId: string, streamId: string): Promise<void> {
    assertId("user", userId);
    assertId("stream", streamId);
    await rm(this.abs(join(userId, streamId)), { recursive: true, force: true });
  }
}
