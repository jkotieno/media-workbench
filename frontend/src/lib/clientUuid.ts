/**
 * UUIDs for non-secret browser request identities and idempotency keys.
 * crypto.randomUUID() is secure-context-only; remotely hosted Studio is often
 * opened at an HTTP IP/port, where getRandomValues() still works.
 */
let fallbackSequence = 0;

export function createClientUuid(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof browserCrypto?.getRandomValues === "function") {
    browserCrypto.getRandomValues(bytes);
  } else {
    // Only a last-resort, non-cryptographic request identity, never a secret.
    fallbackSequence += 1;
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    const sequence = fallbackSequence;
    for (let i = 0; i < 6; i += 1) bytes[i] ^= (sequence >>> ((i % 4) * 8)) & 0xff;
  }
  // RFC 4122 variant and version 4 layout.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
