import crypto from 'node:crypto';

/** v4 — random UUID */
export function v4(): string {
  return crypto.randomUUID();
}

/** v5 — name-based (SHA-1) UUID */
export function v5(name: string, namespace: string): string {
  // Decode the namespace UUID into bytes
  const nsHex = namespace.replaceAll('-', '');
  const nsBytes = Buffer.from(nsHex, 'hex');
  const nameBytes = Buffer.from(name, 'utf8');

  const hash = crypto.createHash('sha1').update(nsBytes).update(nameBytes).digest();

  // Set version (5) and variant bits
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);

  const h = hash.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

export const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
