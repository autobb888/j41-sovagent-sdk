/**
 * Fixture proof of the wallet-response unwrap path — no wallet, no daemon, no network.
 *
 * extractEncryptedDescriptor() and unwrapAppEncryptionResponse() are the functions that
 * run the instant a real wallet answers an AppEncryptionRequest. Their field names were
 * previously verified only by reading .d.ts files, never by executing them. This file
 * hand-builds the exact structures the wallet is expected to produce — the same shapes
 * verus-typescript-primitives' own ordinalvdxfobject.test.ts uses to fixture
 * AppEncryptionResponseOrdinalVDXFObject — and round-trips them through the two unwrap
 * functions. Every class here is independently constructible; no wallet required.
 *
 * Run: npx tsx spike/encrypted-delivery/unwrap.test.mjs
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { extractEncryptedDescriptor, unwrapAppEncryptionResponse } from './sapling.mjs';

const ok = (m) => console.log(`  ✓ ${m}`);

const mod = await import('verus-typescript-primitives');
const P = mod.default ?? mod;

// A real i-address, reused from verus-typescript-primitives' own test fixtures
// (src/__tests__/vdxf/ordinalvdxfobject.test.ts, TEST_REQUESTID-adjacent literal).
const TEST_REQUEST_ID = 'iD4CrjbJBZmwEZQ4bCWgbHx9tBHGP9mdSQ';

// Two incompatible builds of verus-typescript-primitives are in play, and this
// fixture has to run on both — box 2 installs the real pin, while some checkouts
// still carry a stale build from before the rename:
//   real pin: field is `pkD`; the constructor THROWS on a `pk_d` key, and `pk_d`
//             survives only as a deprecated getter (no setter — assigning throws).
//   stale:    field is `pk_d`; a `pkD` constructor key is silently DROPPED, so the
//             address serializes as undefined and dies deep inside toBuffer().
// Neither constructor key works on both. Detect by the deprecated getter and assign
// the field directly. `sapling.mjs` (the production path) reads `pkD ?? pk_d`.
const IS_REAL_PIN = !!Object.getOwnPropertyDescriptor(P.SaplingPaymentAddress.prototype, 'pk_d')?.get;
const pkdOf = (addr) => addr.pkD ?? addr.pk_d;

function buildSaplingAddress() {
  const addr = new P.SaplingPaymentAddress();
  addr.d = randomBytes(11);
  if (IS_REAL_PIN) addr.pkD = randomBytes(32);
  else addr.pk_d = randomBytes(32);
  return addr;
}

function buildExtendedViewingKey() {
  return new P.SaplingExtendedViewingKey({
    depth: 0,
    parentFVKTag: randomBytes(4),
    childIndex: randomBytes(4),
    chainCode: randomBytes(32),
    ak: randomBytes(32),
    nk: randomBytes(32),
    ovk: randomBytes(32),
    dk: randomBytes(32),
  });
}

function buildExtendedSpendingKey() {
  return new P.SaplingExtendedSpendingKey({
    depth: 0,
    parentFVKTag: randomBytes(4),
    childIndex: randomBytes(4),
    chainCode: randomBytes(32),
    ask: randomBytes(32),
    nsk: randomBytes(32),
    ovk: randomBytes(32),
    dk: randomBytes(32),
  });
}

// ---------------------------------------------------------------------------
// extractEncryptedDescriptor
// ---------------------------------------------------------------------------

{
  const objectdata = randomBytes(48);
  const epk = randomBytes(32);

  const dd = new P.DataDescriptor({
    flags: P.DataDescriptor.FLAG_ENCRYPTED_DATA,
    objectdata,
    epk,
  });
  const ddOrdinal = new P.DataDescriptorOrdinalVDXFObject({ data: dd });
  const genResp = new P.GenericResponse({ details: [ddOrdinal] });
  const b64 = genResp.toBuffer().toString('base64');

  const out = await extractEncryptedDescriptor(b64);
  assert.equal(out.objectdataHex, objectdata.toString('hex'), 'objectdata round-trips');
  assert.equal(out.epkHex, epk.toString('hex'), 'epk round-trips');
  ok('extractEncryptedDescriptor pulls objectdata + epk out of a real GenericResponse');
}

{
  const dd = new P.DataDescriptor({
    flags: P.DataDescriptor.FLAG_ENCRYPTED_DATA,
    objectdata: randomBytes(48),
    epk: randomBytes(32),
    ivk: randomBytes(32),
  });
  // Fixture sanity: constructing with an ivk must actually flip the presence flag,
  // otherwise this test would pass for the wrong reason.
  assert.ok(
    dd.flags.and(P.DataDescriptor.FLAG_INCOMING_VIEWING_KEY_PRESENT).gt(new P.BigNumber(0)),
    'fixture sanity: DataDescriptor({ ivk }) sets FLAG_INCOMING_VIEWING_KEY_PRESENT',
  );

  const ddOrdinal = new P.DataDescriptorOrdinalVDXFObject({ data: dd });
  const genResp = new P.GenericResponse({ details: [ddOrdinal] });
  const b64 = genResp.toBuffer().toString('base64');

  await assert.rejects(
    () => extractEncryptedDescriptor(b64),
    /decryption key inline/,
    'a wallet response embedding an ivk must be refused',
  );
  ok('extractEncryptedDescriptor refuses a descriptor carrying an inline ivk');
}

{
  const dd = new P.DataDescriptor({
    flags: P.DataDescriptor.FLAG_ENCRYPTED_DATA,
    objectdata: randomBytes(48),
    epk: randomBytes(32),
    ssk: randomBytes(32),
  });
  const ddOrdinal = new P.DataDescriptorOrdinalVDXFObject({ data: dd });
  const genResp = new P.GenericResponse({ details: [ddOrdinal] });
  const b64 = genResp.toBuffer().toString('base64');

  await assert.rejects(
    () => extractEncryptedDescriptor(b64),
    /decryption key inline/,
    'a wallet response embedding an ssk must be refused',
  );
  ok('extractEncryptedDescriptor refuses a descriptor carrying an inline ssk (same guard, other flag)');
}

// ---------------------------------------------------------------------------
// unwrapAppEncryptionResponse
// ---------------------------------------------------------------------------

{
  const address = buildSaplingAddress();
  const incomingViewingKey = randomBytes(32);
  const extendedViewingKey = buildExtendedViewingKey();
  const requestID = P.CompactIAddressObject.fromAddress(TEST_REQUEST_ID);

  const details = new P.AppEncryptionResponseDetails({
    version: new P.BigNumber(1),
    requestID,
    incomingViewingKey,
    extendedViewingKey,
    address,
  });

  // The real double-wrap: VdxfUniValue -> inner DataDescriptor -> AppEncryptionResponseDetails.
  const uni = new P.VdxfUniValue({
    values: [{ [P.DataDescriptorKey.vdxfid]: new P.DataDescriptor({ objectdata: details.toBuffer() }) }],
  });
  const plaintextBuf = uni.toBuffer();

  const out = await unwrapAppEncryptionResponse(plaintextBuf);

  const expectedAddr = Buffer.concat([address.d, pkdOf(address)]);
  assert.equal(Buffer.from(out.addressHex, 'hex').length, 43, 'address is 43 raw bytes');
  assert.equal(out.addressHex, expectedAddr.toString('hex'), 'address bytes round-trip (d || pkD, in order)');
  assert.equal(Buffer.from(out.ivkHex, 'hex').length, 32, 'ivk is 32 raw bytes');
  assert.equal(out.ivkHex, incomingViewingKey.toString('hex'), 'ivk round-trips');
  assert.equal(out.requestId, requestID.toIAddress(), 'requestId round-trips');
  assert.equal(out.hasSpendingKey, false, 'no spending key present means hasSpendingKey is false');
  ok('unwrapAppEncryptionResponse double-unwraps VdxfUniValue -> DataDescriptor -> AppEncryptionResponseDetails');
}

{
  const address = buildSaplingAddress();
  const extendedViewingKey = buildExtendedViewingKey();
  const extendedSpendingKey = buildExtendedSpendingKey();

  const details = new P.AppEncryptionResponseDetails({
    version: new P.BigNumber(1),
    incomingViewingKey: randomBytes(32),
    extendedViewingKey,
    extendedSpendingKey,
    address,
  });

  const uni = new P.VdxfUniValue({
    values: [{ [P.DataDescriptorKey.vdxfid]: new P.DataDescriptor({ objectdata: details.toBuffer() }) }],
  });
  const plaintextBuf = uni.toBuffer();

  const out = await unwrapAppEncryptionResponse(plaintextBuf);
  assert.equal(out.hasSpendingKey, true, 'a present extendedSpendingKey must be reported, not silently dropped');
  ok('unwrapAppEncryptionResponse reports hasSpendingKey=true so the CLI can fail loudly on a spend-capable reply');
}

console.log('\nWALLET-RESPONSE UNWRAP FIXTURES PASS');
