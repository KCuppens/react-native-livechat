import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type Message,
} from "@kobecuppens/livechat-protocol";
import type { Env } from "../env";
import { hmacSha256Hex, timingSafeEqualStr } from "../lib/crypto";
import { ApiException } from "../lib/errors";
import { newId } from "../lib/ids";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Magic-byte check so a declared image/pdf is really one (defense against stored XSS via HTML uploads). */
function sniffMatches(contentType: string, bytes: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const ascii = (offset: number, text: string) => [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));
  switch (contentType) {
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/gif":
      return ascii(0, "GIF8");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/heic":
      return ascii(4, "ftyp");
    case "application/pdf":
      return ascii(0, "%PDF");
    default:
      return false;
  }
}

/**
 * Reads the body but stops as soon as it exceeds `max` bytes, so a chunked upload without a
 * Content-Length can't make us buffer ~100 MB before the size check.
 */
async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ApiException(413, "too_large", "File is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function storeAttachment(
  env: Env,
  req: Request,
  workspaceId: string,
  uploader: { type: "contact" | "agent"; id: string },
): Promise<Attachment> {
  const contentType = (req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(contentType)) {
    throw new ApiException(415, "unsupported_type", "This file type isn't supported");
  }
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > MAX_ATTACHMENT_BYTES) throw new ApiException(413, "too_large", "File is too large");
  const body = await readCapped(req, MAX_ATTACHMENT_BYTES);
  if (body.byteLength === 0) throw new ApiException(400, "empty_file", "File is empty");
  if (body.byteLength > MAX_ATTACHMENT_BYTES) throw new ApiException(413, "too_large", "File is too large");
  if (!sniffMatches(contentType, body)) throw new ApiException(415, "type_mismatch", "File contents don't match its type");

  let name = "file";
  try {
    name = decodeURIComponent(req.headers.get("X-Filename") ?? "file");
  } catch {
    // keep default
  }
  name = name.replace(/[\\/\r\n"]/g, "_").slice(0, 200) || "file";
  const dim = (h: string) => {
    const n = Number(req.headers.get(h));
    return Number.isInteger(n) && n > 0 && n < 50_000 ? n : null;
  };
  const width = dim("X-Width");
  const height = dim("X-Height");

  const id = newId("att");
  const key = `${workspaceId}/${id}`;
  await env.ATTACHMENTS.put(key, body, { httpMetadata: { contentType } });
  await env.DB.prepare(
    `INSERT INTO attachments (id, workspace_id, uploader_type, uploader_id, r2_key, name, content_type, size, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, workspaceId, uploader.type, uploader.id, key, name, contentType, body.byteLength, width, height, Date.now())
    .run();
  const attachment: Attachment = { id, name, contentType, size: body.byteLength, ...(width ? { width } : {}), ...(height ? { height } : {}) };
  return { ...attachment, url: await signedUrl(env, id) };
}

async function signature(env: Env, id: string, exp: number): Promise<string> {
  return (await hmacSha256Hex(env.ATTACHMENT_SIGNING_KEY, `att:${id}:${exp}`)).slice(0, 32);
}

/** URLs expire at a weekly boundary (1–2 weeks out) so they're stable and cacheable for a while. */
export async function signedUrl(env: Env, id: string, now = Date.now()): Promise<string> {
  const exp = (Math.floor(now / WEEK_MS) + 2) * WEEK_MS;
  return `${env.PUBLIC_URL}/files/${id}?exp=${exp}&sig=${await signature(env, id, exp)}`;
}

export async function verifySignedUrl(env: Env, id: string, exp: string | undefined, sig: string | undefined): Promise<boolean> {
  const expNum = Number(exp);
  if (!sig || !Number.isFinite(expNum) || expNum < Date.now()) return false;
  return timingSafeEqualStr(await signature(env, id, expNum), sig);
}

/** Adds signed URLs to a message's attachments before it leaves the server. */
export async function presentMessage(env: Env, message: Message): Promise<Message> {
  if (message.attachments.length === 0) return message;
  return {
    ...message,
    attachments: await Promise.all(message.attachments.map(async (a) => ({ ...a, url: await signedUrl(env, a.id) }))),
  };
}

export function presentMessages(env: Env, messages: Message[]): Promise<Message[]> {
  return Promise.all(messages.map((m) => presentMessage(env, m)));
}

export async function serveAttachment(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT r2_key, name, content_type FROM attachments WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string; name: string; content_type: string }>();
  const object = row ? await env.ATTACHMENTS.get(row.r2_key) : null;
  if (!row || !object) return new Response("Not found", { status: 404 });
  const inline = row.content_type.startsWith("image/");
  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
