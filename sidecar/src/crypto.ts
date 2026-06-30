import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 32;

export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export async function hashCredential(credential: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(credential, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$v1$${salt}$${key.toString("base64url")}`;
}

export async function verifyCredential(credential: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") {
    return false;
  }

  const [, , salt, expectedEncoded] = parts;
  const expected = Buffer.from(expectedEncoded, "base64url");
  const actual = (await scrypt(credential, salt, expected.length)) as Buffer;

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}
