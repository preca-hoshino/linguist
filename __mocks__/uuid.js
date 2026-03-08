/**
 * Jest CJS shim for the `uuid` package (v13 is pure ESM).
 * Implements the subset used in this project: v4 and v5.
 */
'use strict';

const crypto = require('crypto');

/** v4 — random UUID */
function v4() {
  return crypto.randomUUID();
}

/** v5 — name-based (SHA-1) UUID */
function v5(name, namespace) {
  // Decode the namespace UUID into bytes
  const nsHex = namespace.replace(/-/g, '');
  const nsBytes = Buffer.from(nsHex, 'hex');
  const nameBytes = Buffer.from(name, 'utf8');

  const hash = crypto.createHash('sha1').update(nsBytes).update(nameBytes).digest();

  // Set version (5) and variant bits
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const h = hash.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

// Expose the same named namespaces that uuid exposes
v5.DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
v5.URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

module.exports = { v4, v5 };
