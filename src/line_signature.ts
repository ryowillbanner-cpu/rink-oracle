// LINE の Webhook 署名（x-line-signature）を検証する。
// 署名 = Base64(HMAC-SHA256(チャネルシークレット, リクエストボディ))

const encoder = new TextEncoder();

export async function computeSignature(channelSecret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export async function verifySignature(
  channelSecret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  const expected = await computeSignature(channelSecret, body);
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
