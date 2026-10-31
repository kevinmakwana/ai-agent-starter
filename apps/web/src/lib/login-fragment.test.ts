import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readLoginToken } from './login-fragment';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1234';

describe('readLoginToken', () => {
  it('reads the token from the fragment the email link carries', () => {
    assert.equal(readLoginToken(`#token=${TOKEN}`), TOKEN);
  });

  it('returns null for anything else: no fragment, other keys, extra parts, odd characters, too short or too long', () => {
    for (const hash of ['', '#', '#token=', '#tok=abc', `#token=${TOKEN}&x=1`, `#token=${TOKEN}/`, '#token=short', `#token=${'a'.repeat(600)}`, `token=${TOKEN}`, '#token=has space-has space-has space']) {
      assert.equal(readLoginToken(hash), null, hash);
    }
  });
});
