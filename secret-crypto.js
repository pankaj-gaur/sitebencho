const crypto = require('crypto');

// AES-256-GCM: authenticated encryption — decryption fails loudly (instead
// of silently returning garbage) if the ciphertext, IV, or auth tag has
// been tampered with or doesn't match the key. 12-byte IV is the GCM
// standard/recommended size.
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

// Values in this format are treated as encrypted; anything else is treated
// as plaintext (backward compatible with existing unencrypted configs —
// encryption is opt-in per key, migrate at your own pace).
const ENC_PREFIX = 'enc:v1:';

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Reads the master key from AI_CONFIG_ENCRYPTION_KEY (a 64-character hex
 * string = 32 bytes). Returns null if unset — callers decide whether that's
 * an error (only matters if something is actually encrypted). Never reads
 * the master key from any file — it must come from the environment.
 */
function getMasterKey() {
  const hex = process.env.AI_CONFIG_ENCRYPTION_KEY;
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `AI_CONFIG_ENCRYPTION_KEY must be a ${KEY_BYTES * 2}-character hex string (${KEY_BYTES} bytes) — ` +
      'generate one with: node encrypt-secret.js --generate-key'
    );
  }
  return buf;
}

/**
 * Encrypts a plaintext string, returning a single self-contained string
 * (enc:v1:<iv>:<authTag>:<ciphertext>, all hex) — safe to paste directly
 * into ai-config.json as the value of "apiKey".
 */
function encryptSecret(plaintext, masterKey) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENC_PREFIX + [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/**
 * Reverses encryptSecret. Throws (doesn't silently return garbage) if the
 * master key is wrong or the value has been altered — GCM's auth tag check
 * fails loudly in both cases.
 */
function decryptSecret(encoded, masterKey) {
  const rest = encoded.slice(ENC_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value — expected enc:v1:<iv>:<authTag>:<ciphertext>');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, masterKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Takes whatever is in an "apiKey" config field and returns the real key —
 * passes plaintext through unchanged, decrypts an enc:v1:... value using
 * AI_CONFIG_ENCRYPTION_KEY. Throws a clear, specific error (never a cryptic
 * one) when a value is encrypted but the master key is missing, malformed,
 * or wrong.
 */
function resolveApiKey(rawApiKey) {
  if (!isEncrypted(rawApiKey)) return rawApiKey;
  const masterKey = getMasterKey();
  if (!masterKey) {
    throw new Error(
      'this API key is encrypted but AI_CONFIG_ENCRYPTION_KEY is not set in the environment — ' +
      'the key cannot be decrypted'
    );
  }
  try {
    return decryptSecret(rawApiKey, masterKey);
  } catch (e) {
    throw new Error(`failed to decrypt API key — AI_CONFIG_ENCRYPTION_KEY may be wrong, or the value is corrupted (${e.message})`);
  }
}

module.exports = { isEncrypted, getMasterKey, encryptSecret, decryptSecret, resolveApiKey, ENC_PREFIX, KEY_BYTES };
