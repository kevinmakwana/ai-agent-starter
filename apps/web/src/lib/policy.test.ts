import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRule } from './policy';

test('explains that a tool-level review rule applies without mentioning amounts', () => {
  assert.equal(describeRule('tool_requires_review', {}), 'This kind of action always needs review');
  assert.equal(describeRule('tool_requires_review', null), 'This kind of action always needs review');
});

test('keeps the refund rule wording', () => {
  assert.equal(describeRule('always_review', null), 'Every refund needs review');

  const over = describeRule('over_threshold', { threshold: 25, priorRefunded: 10, amount: 15.5 });
  assert.ok(over?.includes('$25.50'), over ?? 'null');
  assert.ok(over?.includes('$25.00'), over ?? 'null');
  assert.equal(describeRule('over_threshold', null), 'At or over the auto-approve limit');

  const under = describeRule('under_threshold', { threshold: 25, priorRefunded: 5, amount: 10 });
  assert.ok(under?.includes('$15.00'), under ?? 'null');
  assert.ok(under?.includes('$25.00'), under ?? 'null');
  assert.equal(describeRule('under_threshold', null), 'Under the auto-approve limit');
});

test('returns null for an unknown or missing rule', () => {
  assert.equal(describeRule('something_new', {}), null);
  assert.equal(describeRule(null, null), null);
});
