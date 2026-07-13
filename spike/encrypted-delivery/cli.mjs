/**
 * Interop harness — run on box 2 (the dispatcher machine, no daemon).
 *
 * Box 2 plays BOTH the buyer's client (holds the ephemeral ivk, decrypts) and the
 * agent (encrypts the deliverable). Both halves are daemon-less, so one machine
 * can drive the whole loop while bb stays structurally blind.
 *
 *   node cli.mjs keygen                # ephemeral key; the ivk stays here
 *   node cli.mjs request <verusid>     # mint the QR on bb; scan it with Valu
 *   node cli.mjs fetch                 # collect the blob; decrypt it; reveal the buyer key
 *   node cli.mjs roundtrip             # encrypt as the agent, decrypt as the buyer
 *
 * API=https://api.junction41.io by default.
 *
 * <verusid> on `request` is `expectedSigner` — the identity the user will sign with
 * in the wallet. The QR is public and carries the ephemeral z-address (a public
 * key), so without this the server could not tell a legitimate answer from an
 * attacker who scans the same QR, signs with their own identity, and POSTs a
 * substituted delivery address first. The server enforces this and rejects a
 * mismatched signer with 403 SIGNER_MISMATCH — see README.md for the full
 * error-code cheatsheet.
 *
 * POST /v1/encryption/keyreq and GET /v1/encryption/keyreq/:id both require
 * `Authorization: Bearer $ENCRYPTION_SPIKE_TOKEN`. The wallet's callback is NOT
 * gated (it cannot present a token) — that is by design.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  keygen, encryptToAddress, decryptWithIvk,
  extractEncryptedDescriptor, unwrapAppEncryptionResponse,
} from './sapling.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, '.state.json');
const API = process.env.API ?? 'https://api.junction41.io';

const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});
// .state.json holds the buyer's derived ivk, which decrypts every future delivery to
// that address — it must never be world-readable. writeFileSync's `mode` option is only
// honored when the file is *created*; on an existing file it's silently ignored, so we
// chmod explicitly every time regardless of whether this call created or overwrote it.
const save = (s) => {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(STATE, 0o600);
};
const need = (s, k, hint) => {
  if (!s[k]) { console.error(`Missing ${k}. Run: node cli.mjs ${hint}`); process.exit(1); }
  return s[k];
};

/** ENCRYPTION_SPIKE_TOKEN gates POST /v1/encryption/keyreq and GET .../:id (not the
 * wallet's callback). Missing it here is a client-side problem — 503 ENCRYPTION_DISABLED
 * from the server is a different, server-side problem (see explainError). */
function requireToken() {
  const token = process.env.ENCRYPTION_SPIKE_TOKEN;
  if (!token) {
    console.error('Missing ENCRYPTION_SPIKE_TOKEN environment variable.');
    console.error('Ask the operator for the spike bearer token, then:');
    console.error('  export ENCRYPTION_SPIKE_TOKEN=<token>');
    process.exit(1);
  }
  return token;
}

/**
 * Known backend error codes (see README.md "Troubleshooting" for the full cheatsheet).
 *
 * Two different delivery paths land here:
 *  - Most of these come straight back as the HTTP response to a `request`/`fetch` call
 *    (explainError reads them off the JSON body directly).
 *  - The wallet-callback codes (SIGNER_MISMATCH, PLAINTEXT_KEY_RESPONSE,
 *    DISALLOWED_DETAIL_TYPE, INVALID_SIGNATURE, INVALID_RESPONSE) are never an HTTP
 *    response *to this CLI* — the wallet is the one that POSTs the callback and sees
 *    that status. They reach us secondhand via `lastError` on the polled row (see the
 *    `fetch` handler below) and are looked up in this same table.
 */
const ERROR_NOTES = {
  SIGNER_MISMATCH:
    "The most likely first-scan failure, and NOT an attack: the user picked a different\n" +
    "  identity in the wallet's selector than the one passed to `request`. Re-run request\n" +
    '  with the identity actually chosen in Valu.',
  PLAINTEXT_KEY_RESPONSE:
    'The wallet answered UNENCRYPTED. Correct rejection (it would have leaked the ivk),\n' +
    '  but the exchange cannot complete. A conversation with the wallet team, not a bug here.',
  DISALLOWED_DETAIL_TYPE:
    "The wallet attached a detail type not on the server's allow-list. The ordinal is in\n" +
    '  the server log — ask the operator to check.',
  INVALID_SIGNATURE:
    "The wallet's envelope signature didn't verify — a wrong/stale signing key, a corrupted\n" +
    '  response, or a replay of an old challenge. Re-mint with `request` and scan fresh; if\n' +
    "  it keeps happening, that's a wallet-side signing bug, not a CLI bug.",
  INVALID_RESPONSE: "The response didn't parse at all. Rule of thumb: 400 = parse, 422 = policy.",
  INVALID_REQUEST:
    "Our own POST body failed validation — most likely `encryptToAddressHex` is not valid\n" +
    '  hex. This is a client-side bug in the CLI, not a wallet or operator problem.',
  UNKNOWN_REQUEST:
    "This challengeId is not one the backend knows about — either it's stale (a\n" +
    '  .state.json left over from a different backend/environment) or the row already\n' +
    '  expired and was swept. Run `node cli.mjs request <verusid>` again.',
  REQUEST_EXPIRED:
    'The request window closed before the wallet answered. Run `node cli.mjs request\n' +
    '  <verusid>` again and scan promptly — see README.md for the current window length.',
  ENCRYPTION_DISABLED:
    'The operator has not set ENCRYPTION_SPIKE_TOKEN on the backend — or set one shorter\n' +
    '  than 32 characters, which the backend treats as equivalent to unset (fail-closed).\n' +
    '  Server-side config gap either way, not something the CLI can fix — hand this back to\n' +
    '  the operator.',
  UNAUTHORIZED:
    'ENCRYPTION_SPIKE_TOKEN is missing or does not match what the operator set on the\n' +
    '  backend. Double check the exported value.',
  UNKNOWN_SIGNER:
    'expectedSigner could not be resolved to an identity on-chain. Check spelling — friendly\n' +
    '  names need the trailing @, e.g. gg.agentplatform@.',
  CHAIN_SYNCING:
    "The backend's Verus daemon is behind chain tip and refusing to serve requests that\n" +
    '  need a synced view. NOT a token/config problem — wait for it to catch up and retry.\n' +
    '  On this deployment a memory watchdog periodically pauses the testnet daemon and the\n' +
    '  testnet node has a daily shutoff window; both self-heal without operator action.',
  RPC_UNAVAILABLE:
    "The backend can't reach its Verus daemon at all (stopped, restarting, or network\n" +
    '  issue). Also NOT a token/config problem — wait and retry; ask the operator if it\n' +
    '  persists past a few minutes.',
};

async function explainError(res) {
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const code = body?.error;
  const message = body?.message;
  console.error(`  HTTP ${res.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`);
  if (!code && text) console.error(`  ${text}`);
  if (code && ERROR_NOTES[code]) {
    console.error(`  ${ERROR_NOTES[code]}`);
  } else if (res.status === 503) {
    console.error('  503 without a recognized code — most likely CHAIN_SYNCING or');
    console.error('  RPC_UNAVAILABLE (daemon lag/outage; wait and retry), or ENCRYPTION_DISABLED');
    console.error('  (missing/weak token). NOT necessarily a token problem — check the code above.');
  }
  process.exit(1);
}

const cmd = process.argv[2];

if (cmd === 'keygen') {
  const { addressHex, ivkHex } = await keygen();
  save({ ...load(), ephemeral: { addressHex, ivkHex } });
  console.log('Ephemeral transport key generated.');
  console.log(`  address (public, goes to bb): ${addressHex}`);
  console.log(`  ivk     (SECRET, stays here): ${ivkHex.slice(0, 8)}… [${ivkHex.length / 2} bytes]`);
  console.log('\nbb never sees the ivk — that is what makes it a blind relay.');

} else if (cmd === 'request') {
  const s = load();
  const eph = need(s, 'ephemeral', 'keygen');

  const argSigner = process.argv[3];
  // What the operator typed — usually a friendly name (e.g. gg.agentplatform@). Kept
  // around only for display and as a re-mint default; it is NEVER what we compare
  // against in `fetch` (see below).
  const expectedSignerInput = argSigner ?? s.expectedSignerInput ?? s.expectedSigner;
  if (!expectedSignerInput) {
    console.error('Missing expectedSigner. Usage: node cli.mjs request <verusid>');
    console.error('  <verusid> is the identity YOU will sign with in Valu (i-address or');
    console.error('  friendly name, e.g. gg.agentplatform@). The server rejects a callback');
    console.error('  signed by anyone else with 403 SIGNER_MISMATCH — see README.md.');
    process.exit(1);
  }

  const token = requireToken();

  const res = await fetch(`${API}/v1/encryption/keyreq`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      encryptToAddressHex: eph.addressHex,
      derivationNumber: 0,
      expectedSigner: expectedSignerInput,
    }),
  });
  if (!res.ok) { console.error('Mint failed:'); await explainError(res); }
  // expectedSigner here (if present) is the backend's RESOLVED i-address for whatever
  // we sent above — not an echo of our input. The backend always reports the signer on
  // the answered row as an i-address too, so this is what `fetch` must compare against
  // for a like-for-like check. Older backends that don't echo this field yet fall back
  // to comparing against the raw input, which reproduces the original bug for friendly
  // names — flagged loudly below rather than silently.
  const { challengeId, deeplink, qrDataUrl, expiresAt, expectedSigner: resolvedSigner } = await res.json();

  const png = path.join(HERE, 'qr.png');
  fs.writeFileSync(png, Buffer.from(qrDataUrl.split(',')[1], 'base64'));
  save({
    ...s,
    expectedSignerInput,
    expectedSigner: resolvedSigner ?? expectedSignerInput,
    challengeId,
  });

  console.log(`Request minted: ${challengeId}`);
  console.log(`  you typed:       ${expectedSignerInput}`);
  if (resolvedSigner) {
    console.log(`  resolved signer: ${resolvedSigner}`);
  } else {
    console.log('  resolved signer: (backend did not echo one — comparing against raw input in');
    console.log('    `fetch`; if you typed a friendly name, that compare can spuriously FAIL even');
    console.log('    on a correct scan — see README.md "Known gaps".)');
  }
  if (expiresAt) console.log(`  expires: ${new Date(expiresAt).toISOString()}`);
  console.log(`\nScan this with Valu:  ${png}`);
  console.log(`Or paste the deeplink:\n  ${deeplink}`);
  console.log('\nPrerequisite: a Z Seed must be set up for VRSCTEST (Settings → Profile),');
  console.log('or the wallet will refuse the request outright.');
  console.log('\nIMPORTANT: in Valu, sign with the SAME identity passed above');
  console.log(`(${expectedSignerInput}). Signing with any other identity gets 403 SIGNER_MISMATCH.`);
  console.log('\nAfter approving in the wallet:  node cli.mjs fetch');

} else if (cmd === 'fetch') {
  const s = load();
  const eph = need(s, 'ephemeral', 'keygen');
  const challengeId = need(s, 'challengeId', 'request <verusid>');
  const token = requireToken();

  const res = await fetch(`${API}/v1/encryption/keyreq/${challengeId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) { console.error('Fetch failed:'); await explainError(res); }
  const row = await res.json();

  if (row.status !== 'answered' || !row.responseBlob) {
    // A pending row and a REJECTED row look identical unless we surface `lastError`:
    // both report `status: pending` with no responseBlob. Without this check, a wallet
    // that scanned, answered, and got 403 SIGNER_MISMATCH prints the exact same message
    // as a QR nobody has scanned yet — the operator has no way to tell "not yet" from
    // "tried and failed" and burns a full debugging cycle finding out which.
    if (row.lastError) {
      const when = row.lastErrorAt ? ` at ${new Date(row.lastErrorAt).toISOString()}` : '';
      console.error(`Status: ${row.status} — but the wallet DID answer${when}, and was REJECTED.`);
      console.error(`  code: ${row.lastError}`);
      if (ERROR_NOTES[row.lastError]) {
        console.error(`  ${ERROR_NOTES[row.lastError]}`);
      } else {
        console.error('  (no local note for this code — see README.md error-code cheatsheet.)');
      }
      console.error('\nThis is NOT "never scanned" — re-mint with `node cli.mjs request <verusid>`');
      console.error('after addressing the cause above, then scan again.');
      process.exit(1);
    }
    console.log(`Status: ${row.status} — the wallet has not answered yet. Scan the QR, then retry.`);
    process.exit(0);
  }
  console.log(`Wallet answered. Signer: ${row.signer}`);
  if (s.expectedSigner && row.signer !== s.expectedSigner) {
    // Belt-and-suspenders: the server already enforces this (403 SIGNER_MISMATCH on the
    // callback), so an answered+stored row should never disagree. Flag it anyway rather
    // than silently trusting a mismatch. Like-for-like ONLY if `s.expectedSigner` is the
    // resolved i-address the mint stored (see `request`) — `row.signer` is always an
    // i-address, so comparing it against a still-unresolved friendly name here would be
    // a false FAIL on a genuinely correct scan, not a real mismatch.
    console.error(`  ✗ FAIL: stored signer (${row.signer}) != expected (${s.expectedSigner})`);
    process.exit(1);
  }

  const ct = await extractEncryptedDescriptor(row.responseBlob);
  console.log('  ✓ response carries NO inline ivk/ssk — bb could not have read this');

  const plaintext = await decryptWithIvk({ ...ct, ivkHex: eph.ivkHex });
  console.log('  ✓ decrypted with our ephemeral ivk');

  const buyer = await unwrapAppEncryptionResponse(plaintext);
  if (buyer.hasSpendingKey) {
    console.error('  ✗ FAIL: wallet returned a SPENDING key. FLAG_RETURN_ESK must be unset.');
    process.exit(1);
  }
  if (buyer.requestId && buyer.requestId !== challengeId) {
    console.error(`  ✗ FAIL: response binds to ${buyer.requestId}, not ${challengeId}`);
    process.exit(1);
  }
  console.log('  ✓ no spending key; response binds to our request');

  save({ ...s, buyer });
  console.log(`\nBuyer derived key:`);
  console.log(`  address: ${buyer.addressHex}`);
  console.log(`  ivk:     ${buyer.ivkHex.slice(0, 8)}… [${buyer.ivkHex.length / 2} bytes]`);
  console.log('\nNow:  node cli.mjs roundtrip');

} else if (cmd === 'roundtrip') {
  const s = load();
  const buyer = need(s, 'buyer', 'fetch');

  const deliverable = Buffer.from(`spike deliverable — only the buyer may read this`, 'utf8');

  const ct = await encryptToAddress(buyer.addressHex, deliverable);
  console.log('  ✓ AGENT encrypted the deliverable to the buyer — no daemon involved');

  const out = await decryptWithIvk({ ...ct, ivkHex: buyer.ivkHex });
  if (out.toString('utf8') !== deliverable.toString('utf8')) {
    console.error('  ✗ FAIL: decrypted plaintext does not match');
    process.exit(1);
  }
  console.log('  ✓ BUYER decrypted it with the wallet-derived ivk');
  console.log('\nPASS — Valu answers the request, its keys are standard Sapling keys,');
  console.log('the agent can encrypt without a daemon, and bb never held a key.');

} else {
  console.log('usage: node cli.mjs <keygen|request <verusid>|fetch|roundtrip>');
  console.log('  keygen              ephemeral key; the ivk stays here');
  console.log('  request <verusid>   mint the QR on bb; scan it with Valu, signing as <verusid>');
  console.log('  fetch               collect the blob; decrypt it; reveal the buyer key');
  console.log('  roundtrip           encrypt as the agent, decrypt as the buyer');
  console.log('\nRequires env ENCRYPTION_SPIKE_TOKEN for request/fetch. See README.md.');
  process.exit(1);
}
