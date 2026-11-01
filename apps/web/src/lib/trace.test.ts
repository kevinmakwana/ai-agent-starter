import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { isBlockedResult } from './trace';

describe('isBlockedResult', () => {
  it('is true for a result with an error, and for a rejected approval', () => {
    assert.equal(isBlockedResult({ error: 'Access denied', code: 'CROSS_CUSTOMER' }), true);
    assert.equal(isBlockedResult({ status: 'rejected' }), true);
  });

  it('is false for an ordinary result', () => {
    assert.equal(isBlockedResult({ order: { id: 1 } }), false);
    assert.equal(isBlockedResult({ status: 'refunded' }), false);
    assert.equal(isBlockedResult({ error: '' }), false);
  });

  it('is false for results that are not objects, which a step may hold', () => {
    for (const v of [null, undefined, 'text', 42, [], true]) assert.equal(isBlockedResult(v), false);
  });
});
