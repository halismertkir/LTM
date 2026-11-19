import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";

// scrypt cost: N=2^15, r=8, p=1 (about 32 MiB, tens of ms) — interactive-login strength.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password.normalize("NFKC"),
      salt,
      KEY_LEN,
      { N: n, r, p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$salt$hash` (base64). Parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const key = await scrypt(password, salt, n, r, p);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to compare against when the user does not exist, so timing does not reveal it. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type TokenKind = "session" | "device";
const TOKEN_PREFIX: Record<TokenKind, string> = { session: "ltm_s_", device: "ltm_d_" };

/** Opaque bearer token; only its SHA-256 is stored. The prefix says which table to look in. */
export function newToken(kind: TokenKind): string {
  return TOKEN_PREFIX[kind] + randomBytes(32).toString("base64url");
}

export function tokenKind(token: string): TokenKind | null {
  if (token.startsWith(TOKEN_PREFIX.session)) return "session";
  if (token.startsWith(TOKEN_PREFIX.device)) return "device";
  return null;
}

// Pairing codes: alphabet without 0/O/1/I/L so they survive being read aloud or typed.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** e.g. "K7QF-2MXD" */
export function newPairingCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Case-insensitive, ignores dashes/spaces. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

/** AES-256-GCM with a per-record random nonce and a context string as AAD. */
export class SecretBox {
  private readonly key: Buffer;
  constructor(masterKey: Buffer, purpose: string) {
    // Derive a purpose-bound sub-key so the instance secret is never used directly.
    this.key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), `ltm:${purpose}`, 32));
  }

  seal(plaintext: string, aad: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
  }

  open(sealed: string, aad: string): string {
    const buf = Buffer.from(sealed, "base64");
    if (buf.length < 12 + 16) throw new Error("sealed value too short");
    const nonce = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}
