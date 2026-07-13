import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ACCEPT_ATTEMPTS,
  recordAcceptFailure,
  clearAcceptFailure,
  pruneAcceptFailures,
} from '../src/jobs/accept-retry.js';

test('below the cap, failures are recorded but the caller must keep retrying', () => {
  const failures = new Map<string, number>();
  for (let i = 1; i < MAX_ACCEPT_ATTEMPTS; i++) {
    const r = recordAcceptFailure(failures, 'jobA');
    assert.equal(r.attempts, i);
    assert.equal(r.giveUp, false, `attempt ${i} must not give up yet`);
  }
  assert.equal(failures.get('jobA'), MAX_ACCEPT_ATTEMPTS - 1);
});

test('at the cap, giveUp flips true exactly once', () => {
  const failures = new Map<string, number>();
  let giveUpCount = 0;
  let firstGiveUpAttempt = -1;
  for (let i = 1; i <= MAX_ACCEPT_ATTEMPTS; i++) {
    const r = recordAcceptFailure(failures, 'jobB');
    if (r.giveUp) {
      giveUpCount++;
      if (firstGiveUpAttempt === -1) firstGiveUpAttempt = r.attempts;
    }
  }
  assert.equal(giveUpCount, 1, 'exactly one attempt in the run reaches the cap');
  assert.equal(firstGiveUpAttempt, MAX_ACCEPT_ATTEMPTS, 'giveUp fires on the MAX_ACCEPT_ATTEMPTS-th failure');
});

test('a custom maxAttempts is honored', () => {
  const failures = new Map<string, number>();
  assert.equal(recordAcceptFailure(failures, 'x', 2).giveUp, false);
  assert.equal(recordAcceptFailure(failures, 'x', 2).giveUp, true);
});

test('clearAcceptFailure resets the counter — a later failure starts fresh', () => {
  const failures = new Map<string, number>();
  recordAcceptFailure(failures, 'flaky');
  recordAcceptFailure(failures, 'flaky');
  assert.equal(failures.get('flaky'), 2);

  clearAcceptFailure(failures, 'flaky');
  assert.equal(failures.has('flaky'), false);

  const again = recordAcceptFailure(failures, 'flaky');
  assert.equal(again.attempts, 1, 'counter restarts after a success clears it');
});

test('clearAcceptFailure on an untracked id is a no-op', () => {
  const failures = new Map<string, number>();
  assert.doesNotThrow(() => clearAcceptFailure(failures, 'never-seen'));
  assert.equal(failures.size, 0);
});

test('pruneAcceptFailures drops entries for jobs no longer pending', () => {
  const failures = new Map<string, number>();
  recordAcceptFailure(failures, 'gone');
  recordAcceptFailure(failures, 'still-pending');

  const pruned = pruneAcceptFailures(failures, new Set(['still-pending']));

  assert.equal(pruned, 1);
  assert.equal(failures.has('gone'), false);
  assert.equal(failures.has('still-pending'), true);
});

test('pruneAcceptFailures leaves an in-progress retry alone while it is still pending', () => {
  const failures = new Map<string, number>();
  for (let i = 0; i < MAX_ACCEPT_ATTEMPTS - 1; i++) recordAcceptFailure(failures, 'poison');

  pruneAcceptFailures(failures, new Set(['poison']));

  assert.equal(failures.get('poison'), MAX_ACCEPT_ATTEMPTS - 1, 'counter survives while still pending');
});

test('independent jobs track independent counters', () => {
  const failures = new Map<string, number>();
  recordAcceptFailure(failures, 'a');
  recordAcceptFailure(failures, 'a');
  recordAcceptFailure(failures, 'b');

  assert.equal(failures.get('a'), 2);
  assert.equal(failures.get('b'), 1);
});
