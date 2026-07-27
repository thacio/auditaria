/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Transport auth + identity primitives (§7.1). Ported nearly verbatim from
// the proven deskstop-streaming shared/src/crypto.ts, with the AAD domain
// strings changed to the hive's own ('hive-auth' / 'hive-auth-ok').
//
// Key schedule:
//   master   = PBKDF2-SHA256(passphrase, salt, 600k) -> imported as HKDF key
//   authKey  = HKDF(master, info="auth")             (handshake proof)
//
// The hub uses a STATIC per-hive salt and caches the derived master key —
// per-connection work is HKDF + one GCM op. Freshness comes from the
// per-connection challenge, not from the salt.
//
// Identity (§4.1): each node holds an ed25519 keypair. The public-key
// fingerprint is TOFU-bound to the nodeId at the relay on first enrollment;
// the relay's own fingerprint is pinned client-side on first join.

import * as nodeCrypto from 'node:crypto';

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_LEN = 16;
export const CHALLENGE_LEN = 32;

const te = new TextEncoder();

// -------------------------------------------------------------------
// Random + encoding helpers
// -------------------------------------------------------------------

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  nodeCrypto.webcrypto.getRandomValues(b);
  return b;
}

export function toB64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function toB64Url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return nodeCrypto.timingSafeEqual(a, b);
}

// -------------------------------------------------------------------
// Passphrase-derived handshake keys (PBKDF2 → HKDF → AES-256-GCM)
// -------------------------------------------------------------------

const subtle = nodeCrypto.webcrypto.subtle;

/** PBKDF2 -> HKDF master key. Slow on purpose; the hub caches the result. */
export async function deriveMaster(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const base = await subtle.importKey(
    'raw',
    te.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256,
  );
  return subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
}

async function hkdfAesKey(
  master: CryptoKey,
  hkdfSalt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: te.encode(info) },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function nonce(seq: bigint): Uint8Array {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, seq);
  return n;
}

async function gcmEncrypt(
  key: CryptoKey,
  aad: Uint8Array,
  plaintext: Uint8Array,
  seq: bigint,
): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce(seq), additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    ),
  );
}

async function gcmDecrypt(
  key: CryptoKey,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  seq: bigint,
): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce(seq), additionalData: aad, tagLength: 128 },
      key,
      ciphertext,
    ),
  );
}

// -------------------------------------------------------------------
// Handshake helpers (challenge-response, mutual)
// -------------------------------------------------------------------

/** Both sides derive this from the passphrase to prove possession. */
export async function deriveAuthKey(
  master: CryptoKey,
  hkdfSalt: Uint8Array,
): Promise<CryptoKey> {
  return hkdfAesKey(master, hkdfSalt, 'auth');
}

const AAD_AUTH = te.encode('hive-auth');
const AAD_AUTH_OK = te.encode('hive-auth-ok');

/** Client: seal the hub's challenge to prove it holds the passphrase. */
export async function makeAuthResponse(
  authKey: CryptoKey,
  challenge: Uint8Array,
): Promise<string> {
  return toB64(await gcmEncrypt(authKey, AAD_AUTH, challenge, 0n));
}

/** Hub: verify the client's response decrypts to the original challenge. */
export async function verifyAuthResponse(
  authKey: CryptoKey,
  response: string,
  challenge: Uint8Array,
): Promise<boolean> {
  try {
    const pt = await gcmDecrypt(authKey, AAD_AUTH, fromB64(response), 0n);
    return ctEqual(pt, challenge);
  } catch {
    return false;
  }
}

/** Hub: prove mutual passphrase possession back to the client. */
export async function makeAuthProof(
  authKey: CryptoKey,
  challenge: Uint8Array,
): Promise<string> {
  return toB64(await gcmEncrypt(authKey, AAD_AUTH_OK, challenge, 1n));
}

/** Client: verify the hub's proof. */
export async function verifyAuthProof(
  authKey: CryptoKey,
  proof: string,
  challenge: Uint8Array,
): Promise<boolean> {
  try {
    const pt = await gcmDecrypt(authKey, AAD_AUTH_OK, fromB64(proof), 1n);
    return ctEqual(pt, challenge);
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------
// ed25519 node/relay identity (§4.1)
// -------------------------------------------------------------------

export interface Ed25519KeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateIdentityKeyPair(): Ed25519KeyPairPem {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}

/** Short, stable, filesystem-safe hash of a string (e.g. a cwd → instance key). */
export function shortHash(text: string, len = 12): string {
  return nodeCrypto
    .createHash('sha256')
    .update(text)
    .digest('base64url')
    .slice(0, len);
}

/** Stable fingerprint of an ed25519 public key: sha256 over the SPKI DER. */
export function fingerprintOfPublicKey(publicKeyPem: string): string {
  const key = nodeCrypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  const hash = nodeCrypto.createHash('sha256').update(der).digest();
  return `sha256:${hash.toString('base64url')}`;
}

/** Sign a challenge with the node/relay private key (proof of key possession). */
export function signChallenge(
  privateKeyPem: string,
  challenge: Uint8Array,
): string {
  const sig = nodeCrypto.sign(
    null,
    Buffer.from(challenge),
    nodeCrypto.createPrivateKey(privateKeyPem),
  );
  return sig.toString('base64');
}

export function verifyChallengeSignature(
  publicKeyPem: string,
  challenge: Uint8Array,
  signatureB64: string,
): boolean {
  try {
    return nodeCrypto.verify(
      null,
      Buffer.from(challenge),
      nodeCrypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------
// Secrets and identifiers
// -------------------------------------------------------------------

/**
 * ~80-bit passphrase, unambiguous lowercase alphabet (no i/l/o/0/1), grouped.
 * e.g. "k7mq-x3rp-9wnz-h4td"
 */
export function makeStrongPassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // 31 chars
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < bytes.length - 1) out += '-';
  }
  return out;
}

/** Unguessable URL path token (Layer 1). */
export function makeUrlToken(): string {
  return toB64Url(randomBytes(16));
}

/** Single-use invite token id, e.g. "inv_9f2kq7x1". */
export function makeInviteTokenId(): string {
  return `inv_${toB64Url(randomBytes(8))}`;
}

export function makeNodeId(): string {
  return `n_${toB64Url(randomBytes(6))}`;
}

// -------------------------------------------------------------------
// Monotonic ULID factory (§5.3) — dedup keys only, never for ordering
// -------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

let ulidLastTime = 0;
let ulidLastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/**
 * Monotonic within this process: same-millisecond calls increment the random
 * component so ids never collide locally. Cross-node uniqueness comes from
 * 80 bits of randomness.
 */
export function makeUlid(now = Date.now()): string {
  if (now === ulidLastTime) {
    // Increment the previous random component (with carry).
    for (let i = ulidLastRandom.length - 1; i >= 0; i--) {
      if (ulidLastRandom[i] < 31) {
        ulidLastRandom[i]++;
        break;
      }
      ulidLastRandom[i] = 0;
    }
  } else {
    ulidLastTime = now;
    const rnd = randomBytes(16);
    ulidLastRandom = Array.from({ length: 16 }, (_, i) => rnd[i] % 32);
  }
  return encodeTime(now) + ulidLastRandom.map((v) => ULID_ALPHABET[v]).join('');
}

// -------------------------------------------------------------------
// Generated nicknames (§4.2) — memorable words, agent_mail-proven style
// -------------------------------------------------------------------

const NICK_ADJECTIVES = [
  'amber',
  'cobalt',
  'crimson',
  'golden',
  'ivory',
  'jade',
  'lunar',
  'mellow',
  'misty',
  'onyx',
  'opal',
  'quiet',
  'rapid',
  'rustic',
  'silver',
  'solar',
  'stormy',
  'swift',
  'velvet',
  'winter',
  'arctic',
  'bold',
  'breezy',
  'bronze',
  'cedar',
  'coral',
  'dusky',
  'ember',
  'fabled',
  'gentle',
  'hazel',
  'indigo',
  'keen',
  'maple',
  'nimble',
  'pearl',
  'sable',
  'tidal',
  'umber',
  'zesty',
];

const NICK_ANIMALS = [
  'falcon',
  'otter',
  'badger',
  'condor',
  'dolphin',
  'ferret',
  'gecko',
  'heron',
  'ibis',
  'jaguar',
  'kestrel',
  'lynx',
  'marmot',
  'narwhal',
  'osprey',
  'panther',
  'quokka',
  'raven',
  'stoat',
  'toucan',
  'alpaca',
  'bison',
  'caracal',
  'dingo',
  'egret',
  'fennec',
  'gannet',
  'hoopoe',
  'impala',
  'jackdaw',
  'koala',
  'lemur',
  'macaw',
  'numbat',
  'ocelot',
  'puffin',
  'serval',
  'tapir',
  'vervet',
  'wombat',
];

export function generateNickname(): string {
  // randomInt is uniform — no modulo bias (256 % len skewed the old draw
  // toward the first entries of each list).
  const adj = NICK_ADJECTIVES[nodeCrypto.randomInt(NICK_ADJECTIVES.length)];
  const animal = NICK_ANIMALS[nodeCrypto.randomInt(NICK_ANIMALS.length)];
  return `${adj}-${animal}`;
}

/**
 * Normalization used for nickname collision detection: case folding,
 * whitespace stripping and common homoglyph mapping — visually-colliding
 * names get suffixed by the hub, not just exact duplicates.
 */
export function normalizeNickname(nickname: string): string {
  return nickname
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[０-９ａ-ｚＡ-Ｚ]/g, (c) =>
      // Fullwidth forms → ASCII
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[а]/g, 'a') // Cyrillic а
    .replace(/[е]/g, 'e') // Cyrillic е
    .replace(/[о]/g, 'o') // Cyrillic о
    .replace(/[с]/g, 'c') // Cyrillic с
    .replace(/[р]/g, 'p') // Cyrillic р
    .replace(/[і]/g, 'i') // Ukrainian і
    .replace(/[1l]/g, 'i')
    .replace(/[0]/g, 'o');
}

// -------------------------------------------------------------------
// External-text hygiene (§4.2/§7.3)
// -------------------------------------------------------------------

/**
 * Sanitize any peer-authored text (card fields, nicknames) before it reaches
 * a model prompt or the UI: strip control characters, cap length.
 */
export function sanitizeExternalText(text: string, maxLen = 400): string {
  // Normalize CRLF/CR to LF first: on the inline typed-delivery path a raw
  // \r would SUBMIT the receiver's PTY input box early, splitting the rest
  // of the prompt into a second prompt (peer-controlled prompt injection).
  // Then strip C0 controls (keeps tab/newline), DEL, and C1 controls —
  // ESC (\x1b) lets a peer body inject terminal escape sequences when typed
  // or rendered, and 0x9B is an 8-bit CSI in some terminals. Peer text must
  // reach a TTY as inert data. Escape-encoded so the source stays plain text.
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u0080-\u009F]/g, '');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

/**
 * Stricter sanitizer for SINGLE-LINE fields (nicknames, machine/provider/cwd,
 * and any value interpolated into a fence attribute or a one-line UI row).
 * Beyond stripping controls it removes ALL newlines/tabs and the characters
 * that would let a value break out of an attribute or forge a roster line
 * (`<`, `>`, `"`), so a peer can't inject adjacent lines next to the
 * per-message fence marker or spoof roster/feed output.
 */
export function sanitizeInline(text: string, maxLen = 80): string {
  const oneLine = sanitizeExternalText(text, maxLen * 2)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>"]/g, '')
    .trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}

/**
 * Per-message random marker for the external-content fence
 * (<hive_message_X9f2 …>…</hive_message_X9f2>). Randomizing it per message
 * keeps body text from ever being mistaken for the fence itself.
 */
export function makeFenceMarker(): string {
  return toB64Url(randomBytes(3)).replace(/[-_]/g, 'x');
}
