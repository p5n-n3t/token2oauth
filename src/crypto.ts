import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccessClaims, EncryptedSecret } from "./types.js";

export const b64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

export const fromB64url = (value: string) => Buffer.from(value, "base64url");

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function ensureMasterKey(path: string): Promise<Buffer> {
  try {
    const raw = await readFile(path, "utf8");
    const key = Buffer.from(raw.trim(), "base64");
    if (key.length !== 32) throw new Error("master key must be 32 bytes");
    return key;
  } catch (error: any) {
    if (error?.code && error.code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    await writeFile(path, key.toString("base64") + "\n", { mode: 0o600 });
    await chmod(path, 0o600);
    return key;
  }
}

export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      master,
      Buffer.alloc(0),
      Buffer.from("token2oauth:" + purpose),
      32,
    ),
  );
}

export function encryptSecret(secret: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveKey(key, "credential-encryption"),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  if (secret.v !== 1) throw new Error("unsupported secret envelope version");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(key, "credential-encryption"),
    Buffer.from(secret.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(secret.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashPassword(password: string, salt = randomBytes(16)): {
  salt: string;
  hash: string;
} {
  const hash = scryptSync(password, salt, 32);
  return {
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url"),
  };
}

export function verifyPassword(
  password: string,
  record: { salt: string; hash: string },
): boolean {
  const expected = Buffer.from(record.hash, "base64url");
  const actual = scryptSync(
    password,
    Buffer.from(record.salt, "base64url"),
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signPart(input: string, key: Buffer): string {
  return createHmac("sha256", deriveKey(key, "oauth-signing"))
    .update(input)
    .digest("base64url");
}

export function signAccessToken(claims: AccessClaims, key: Buffer): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const body = header + "." + payload;
  return body + "." + signPart(body, key);
}

export function verifyAccessToken(token: string, key: Buffer): AccessClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [header, payload, signature] = parts;
  const body = header + "." + payload;
  const expected = Buffer.from(signPart(body, key), "base64url");
  const actual = Buffer.from(signature, "base64url");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error("invalid signature");
  }
  const parsedHeader = JSON.parse(
    Buffer.from(header, "base64url").toString("utf8"),
  );
  if (parsedHeader.alg !== "HS256") throw new Error("unsupported algorithm");
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as AccessClaims;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp <= now) throw new Error("token expired");
  if (!claims.iss || !claims.aud || !claims.client_id) {
    throw new Error("missing required claims");
  }
  return claims;
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
