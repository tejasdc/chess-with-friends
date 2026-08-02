const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

const publicKey = pointToBase64Url(publicJwk.x, publicJwk.y);

console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY_JSON=" + JSON.stringify(privateJwk));
console.log("");
console.log("Set the public key in wrangler.jsonc vars or with wrangler vars, and set the private key as a Wrangler secret:");
console.log("printf '%s' '<VAPID_PRIVATE_KEY_JSON>' | wrangler secret put VAPID_PRIVATE_KEY");

function pointToBase64Url(x, y) {
  const bytes = new Uint8Array(65);
  bytes[0] = 4;
  bytes.set(base64UrlToBytes(x), 1);
  bytes.set(base64UrlToBytes(y), 33);
  return bytesToBase64Url(bytes);
}

function base64UrlToBytes(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
