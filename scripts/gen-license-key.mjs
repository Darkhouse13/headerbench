#!/usr/bin/env node
// Prints a fresh ed25519 keypair (hex) for signing Headerbench licences. Run: node scripts/gen-license-key.mjs
//   LICENSE_PRIVATE_KEY   -> server env (secret: Coolify only, never commit it)
//   HB_LICENSE_PUBLIC_KEY -> extension build env (public, baked into the extension)
// Needs only `npm install` (no build): @noble/curves is installed for @headerbench/core.
import { ed25519 } from '@noble/curves/ed25519.js';

const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const { secretKey, publicKey } = ed25519.keygen();

process.stdout.write(
  `LICENSE_PRIVATE_KEY=${toHex(secretKey)}\nHB_LICENSE_PUBLIC_KEY=${toHex(publicKey)}\n`,
);
