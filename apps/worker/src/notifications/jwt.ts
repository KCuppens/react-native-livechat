import { fromBase64, toBase64Url } from "../lib/crypto";

const enc = new TextEncoder();

function base64url(input: ArrayBuffer | string): string {
  return toBase64Url(typeof input === "string" ? enc.encode(input) : new Uint8Array(input));
}

function pemToDer(pem: string): ArrayBuffer {
  return fromBase64(pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "")).slice().buffer;
}

export function importRsaKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export function importEcKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Signs a compact JWS. ES256 signatures from WebCrypto are already raw r||s as JWS requires. */
export async function signJwt(
  alg: "RS256" | "ES256",
  key: CryptoKey,
  payload: Record<string, unknown>,
  extraHeader: Record<string, string> = {},
): Promise<string> {
  const header = base64url(JSON.stringify({ alg, typ: "JWT", ...extraHeader }));
  const body = base64url(JSON.stringify(payload));
  const data = enc.encode(`${header}.${body}`);
  const sig =
    alg === "RS256"
      ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data)
      : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return `${header}.${body}.${base64url(sig)}`;
}
