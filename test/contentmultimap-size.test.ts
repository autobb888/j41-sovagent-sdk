import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSubDD,
  contentmultimapValueByteSize,
  assertContentmultimapValueSizes,
  MAX_CONTENTMULTIMAP_VALUE_BYTES,
} from '../src/onboarding/vdxf.js';

// An oversized contentmultimap value (e.g. many/large services serialized into
// one entry) is SILENTLY truncated on-chain past the ~5.5KB script-element
// limit. The guard turns that silent corruption into a loud, actionable error
// before signing. (Verus on-chain-file-storage gotcha #3.)

test('contentmultimapValueByteSize measures the DD message payload', () => {
  const dd = makeSubDD('label', 'x'.repeat(1000));
  assert.equal(contentmultimapValueByteSize(dd), 1000);
});

test('contentmultimapValueByteSize counts UTF-8 bytes, not JS chars', () => {
  const dd = makeSubDD('label', '€'.repeat(100)); // € is 3 UTF-8 bytes
  assert.equal(contentmultimapValueByteSize(dd), 300);
});

test('contentmultimapValueByteSize handles a raw hex objectdata (bytes = hex/2)', () => {
  const hexDD = { i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv: { version: 1, objectdata: 'ab'.repeat(500) } };
  assert.equal(contentmultimapValueByteSize(hexDD), 500);
});

test('assertContentmultimapValueSizes throws (loud) for an oversized value', () => {
  const big = makeSubDD('services', 'x'.repeat(MAX_CONTENTMULTIMAP_VALUE_BYTES + 1));
  assert.throws(
    () => assertContentmultimapValueSizes({ someServicesKey: [big] }),
    (err: Error) => /someServicesKey/.test(err.message) && /truncat/i.test(err.message),
  );
});

test('assertContentmultimapValueSizes passes for a normal-sized value', () => {
  const ok = makeSubDD('description', 'a perfectly reasonable agent bio');
  assert.doesNotThrow(() => assertContentmultimapValueSizes({ desc: [ok] }));
});

test('assertContentmultimapValueSizes reports the array index for multi-value keys', () => {
  const ok = makeSubDD('a', 'small');
  const big = makeSubDD('b', 'y'.repeat(MAX_CONTENTMULTIMAP_VALUE_BYTES + 1));
  assert.throws(
    () => assertContentmultimapValueSizes({ multi: [ok, big] }),
    (err: Error) => /\[1\]/.test(err.message),
  );
});
