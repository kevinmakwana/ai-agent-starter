import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { customerScreen } from './customer-view';

describe('customerScreen', () => {
  it('waits for health, then shows the old demo picker when login is off', () => {
    assert.equal(customerScreen(null, null), 'loading');
    assert.equal(customerScreen({ customerLogin: false }, null), 'demo');
    assert.equal(customerScreen({}, null), 'demo'); // an older API that does not say
  });

  it('asks for sign-in when login is on and nobody is signed in, and shows the chat once someone is', () => {
    assert.equal(customerScreen({ customerLogin: true }, null), 'sign-in');
    assert.equal(customerScreen({ customerLogin: true }, { id: 1 }), 'chat');
  });
});
