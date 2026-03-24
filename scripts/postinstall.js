#!/usr/bin/env node
// Ensures bitcoin-ops/evals.json exists — required by @bitgo/utxo-lib (VerusCoin fork)
// The VerusCoin/bitcoin-ops repo doesn't always include this file.
const { writeFileSync, existsSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');
const target = join(__dirname, '..', 'node_modules', 'bitcoin-ops', 'evals.json');

if (!existsSync(target)) {
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  
  const evals = {
    "EVAL_NONE":0,
    "EVAL_STAKEGUARD":1,
    "EVAL_CURRENCY_DEFINITION":2,
    "EVAL_NOTARY_EVIDENCE":3,
    "EVAL_EARNEDNOTARIZATION":4,
    "EVAL_ACCEPTEDNOTARIZATION":5,
    "EVAL_FINALIZE_NOTARIZATION":6,
    "EVAL_CURRENCYSTATE":7,
    "EVAL_RESERVE_TRANSFER":8,
    "EVAL_RESERVE_OUTPUT":9,
    "EVAL_RESERVE_UNUSED":10,
    "EVAL_RESERVE_DEPOSIT":11,
    "EVAL_CROSSCHAIN_EXPORT":12,
    "EVAL_CROSSCHAIN_IMPORT":13,
    "EVAL_IDENTITY_PRIMARY":14,
    "EVAL_IDENTITY_REVOKE":15,
    "EVAL_IDENTITY_RECOVER":16,
    "EVAL_IDENTITY_COMMITMENT":17,
    "EVAL_IDENTITY_RESERVATION":18,
    "EVAL_FINALIZE_EXPORT":19,
    "EVAL_FEE_POOL":20,
    "EVAL_NOTARY_SIGNATURE":21
  };
  
  writeFileSync(target, JSON.stringify(evals, null, 2) + '\n');
  console.log('✓ Patched bitcoin-ops/evals.json');
}

// ── Patch verus-typescript-primitives VdxfUniValue ──
// The library throws on unknown VDXF keys in contentmultimap.
// agentplatform:: keys (agent.models, agent.services, etc.) are not in the
// hardcoded registry. This patch treats unknown keys as DataDescriptor
// objects (opaque passthrough) instead of throwing.
const { readFileSync } = require('fs');
const vdxfPath = join(__dirname, '..', 'node_modules', 'verus-typescript-primitives', 'dist', 'pbaas', 'VdxfUniValue.js');

if (existsSync(vdxfPath)) {
  let src = readFileSync(vdxfPath, 'utf-8');
  let patched = false;

  // Patch 1: getByteLength — throw → DataDescriptor fallback
  const throw1 = 'throw new Error("contentmap invalid or unrecognized vdxfkey for object type: " + key);';
  const fix1 = `// J41 patch: treat unknown VDXF keys as DataDescriptor (opaque passthrough)
                const descr = new DataDescriptor_1.DataDescriptor(value);
                length += varint_1.default.encodingLength(descr.version);
                length += totalStreamLength(descr.getByteLength());`;
  const fix1b = `// J41 patch: treat unknown VDXF keys as DataDescriptor (opaque passthrough)
                const descr = new DataDescriptor_1.DataDescriptor(value);
                writer.writeSlice((0, address_1.fromBase58Check)(key).hash);
                writer.writeVarInt(descr.version);
                writer.writeCompactSize(descr.getByteLength());
                writer.writeSlice(descr.toBuffer());`;

  // Patch 3: fromJson — throw → DataDescriptor fallback
  const throw3 = 'throw new Error("Unknown vdxfkey: " + oneValValues[k]);';
  const fix3 = `// J41 patch: treat unknown VDXF keys as DataDescriptor (opaque passthrough)
                    const descriptor = DataDescriptor_1.DataDescriptor.fromJson(oneValValues[k]);
                    arrayItem.push({ [objTypeKey]: descriptor });`;

  // Apply patches (replace first occurrence of throw1 with fix1, second with fix1b)
  if (src.includes(throw1)) {
    // First occurrence is in getByteLength
    const idx1 = src.indexOf(throw1);
    src = src.substring(0, idx1) + fix1 + src.substring(idx1 + throw1.length);
    // Second occurrence is in toBuffer
    const idx2 = src.indexOf(throw1);
    if (idx2 >= 0) {
      src = src.substring(0, idx2) + fix1b + src.substring(idx2 + throw1.length);
    }
    patched = true;
  }
  if (src.includes(throw3)) {
    src = src.replace(throw3, fix3);
    patched = true;
  }

  if (patched) {
    writeFileSync(vdxfPath, src);
    console.log('✓ Patched verus-typescript-primitives VdxfUniValue (unknown VDXF key passthrough)');
  }
}
