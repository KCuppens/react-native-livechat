const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

let lastMs = 0;
let seq = 0;

/**
 * Sortable id: `<prefix>_<9 chars ms><4 chars sequence><8 random chars>`.
 * Workers freeze Date.now() within a request, so the per-isolate sequence keeps ids
 * created in the same request (e.g. a message and its auto-reply) in insertion order.
 */
export function newId(prefix: string): string {
  const now = Date.now();
  if (now === lastMs) {
    seq++;
  } else {
    lastMs = now;
    seq = 0;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 36];
  return `${prefix}_${now.toString(36).padStart(9, "0")}${seq.toString(36).padStart(4, "0")}${rand}`;
}
