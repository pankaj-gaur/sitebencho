#!/usr/bin/env node
// Helper for encrypting API keys stored in ai-config.json at rest.
//
// 1. Generate a master key ONCE (not stored in any file by this script —
//    put it wherever this app gets its environment variables from: a
//    process manager, systemd EnvironmentFile with restricted permissions,
//    your host's own secret store, etc. — never alongside ai-config.json):
//
//      node encrypt-secret.js --generate-key
//
// 2. Encrypt each plaintext API key, with the master key available as
//    AI_CONFIG_ENCRYPTION_KEY, and paste the output into ai-config.json as
//    the "apiKey" value for that provider:
//
//      AI_CONFIG_ENCRYPTION_KEY=<hex from step 1> node encrypt-secret.js "AIzaSy...yourRealKey"
//
// The app (ai-summary.js) then only needs AI_CONFIG_ENCRYPTION_KEY set in
// its environment at runtime to decrypt these values — plaintext apiKey
// values keep working unchanged if you don't encrypt them.

const crypto = require('crypto');
const { encryptSecret, KEY_BYTES } = require('./secret-crypto');

function usage() {
  console.error('Usage:');
  console.error('  node encrypt-secret.js --generate-key');
  console.error('  AI_CONFIG_ENCRYPTION_KEY=<hex> node encrypt-secret.js "<plaintext-api-key>"');
}

const args = process.argv.slice(2);

if (args[0] === '--generate-key') {
  console.log(crypto.randomBytes(KEY_BYTES).toString('hex'));
  process.exit(0);
}

const plaintext = args[0];
if (!plaintext) {
  usage();
  process.exit(1);
}

const keyHex = process.env.AI_CONFIG_ENCRYPTION_KEY;
if (!keyHex) {
  console.error('AI_CONFIG_ENCRYPTION_KEY is not set — generate one first with --generate-key, then set it.');
  usage();
  process.exit(1);
}

const masterKey = Buffer.from(keyHex, 'hex');
if (masterKey.length !== KEY_BYTES) {
  console.error(`AI_CONFIG_ENCRYPTION_KEY must be a ${KEY_BYTES * 2}-character hex string (${KEY_BYTES} bytes).`);
  process.exit(1);
}

console.log(encryptSecret(plaintext, masterKey));
