import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListingKind,
  advertisedIdentity,
  leafFromIdentity,
  kindFromIdentityName,
  LISTING_KINDS,
} from '../src/hosting/kinds.js';
import { J41Client } from '../src/client/index.js';

describe('parseListingKind', () => {
  it('accepts agent, compute, data, model', () => {
    assert.equal(parseListingKind('agent'), 'agent');
    assert.equal(parseListingKind('compute'), 'compute');
    assert.equal(parseListingKind('data'), 'data');
    assert.equal(parseListingKind('model'), 'model');
  });

  it('rejects missing and lookalikes', () => {
    assert.equal(parseListingKind(undefined), null);
    assert.equal(parseListingKind(''), null);
    assert.equal(parseListingKind('sovcompute'), null);
    assert.equal(parseListingKind('AGENT'), null);
  });
});

describe('advertisedIdentity', () => {
  it('qualifies every kind under agentplatform@ while DeFi is off', () => {
    assert.equal(advertisedIdentity('alice', 'agent'), 'alice.agentplatform@');
    assert.equal(advertisedIdentity('gpu1', 'compute'), 'gpu1.agentplatform@');
    assert.equal(advertisedIdentity('corpus', 'data'), 'corpus.agentplatform@');
    assert.equal(advertisedIdentity('kimi', 'model'), 'kimi.agentplatform@');
  });

  it('passes through an already-qualified name', () => {
    assert.equal(advertisedIdentity('gpu1.sovcompute@', 'compute'), 'gpu1.sovcompute@');
    assert.equal(advertisedIdentity('gpu1.sovcompute', 'agent'), 'gpu1.sovcompute@');
  });
});

describe('kindFromIdentityName / leafFromIdentity', () => {
  it('reads kind from the parent suffix including the legacy fleet', () => {
    assert.equal(kindFromIdentityName('alice.sovagent@'), 'agent');
    assert.equal(kindFromIdentityName('old.agentplatform@'), 'agent');
    assert.equal(kindFromIdentityName('gpu1.sovcompute@'), 'compute');
    assert.equal(kindFromIdentityName('corpus.sovdata@'), 'data');
    assert.equal(kindFromIdentityName('kimi.sovmodel@'), 'model');
  });

  it('strips any known parent to the leaf', () => {
    assert.equal(leafFromIdentity('gpu1.sovcompute@'), 'gpu1');
    assert.equal(leafFromIdentity('alice.agentplatform@'), 'alice');
    assert.equal(leafFromIdentity('alice'), 'alice');
  });
});

describe('J41Client.onboard sends kind', () => {
  it('defaults kind to agent', async () => {
    const client = new J41Client({ apiUrl: 'https://api.example.com' });
    let body: unknown;
    (client as any).request = async (_m: string, _p: string, b: unknown) => {
      body = b;
      return { status: 'challenge', challenge: 'c', token: 't' };
    };
    await client.onboard('alice', 'Raddr', '02aa');
    assert.deepEqual(body, { name: 'alice', address: 'Raddr', pubkey: '02aa', kind: 'agent' });
  });

  it('POSTs compute kind on both onboard steps', async () => {
    const client = new J41Client({ apiUrl: 'https://api.example.com' });
    const bodies: unknown[] = [];
    (client as any).request = async (_m: string, _p: string, b: unknown) => {
      bodies.push(b);
      return { status: 'challenge', challenge: 'c', token: 't', identity: 'gpu1.sovcompute@', kind: 'compute' };
    };
    await client.onboard('gpu1', 'Raddr', '02aa', 'compute');
    await client.onboardWithSignature('gpu1', 'Raddr', '02aa', 'c', 't', 'sig', 'compute');
    assert.equal((bodies[0] as any).kind, 'compute');
    assert.equal((bodies[1] as any).kind, 'compute');
  });
});

describe('LISTING_KINDS', () => {
  it('includes model as a first-class listing kind', () => {
    assert.deepEqual([...LISTING_KINDS], ['agent', 'compute', 'data', 'model']);
  });
});
