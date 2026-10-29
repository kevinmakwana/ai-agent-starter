import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SseParser } from './sse';

describe('SseParser', () => {
  it('parses an event with data', () => {
    assert.deepEqual(new SseParser().push('event: trace\ndata: {"a":1}\n\n'), [{ event: 'trace', data: '{"a":1}' }]);
  });
  it('defaults the event name to message', () => {
    assert.deepEqual(new SseParser().push('data: hi\n\n'), [{ event: 'message', data: 'hi' }]);
  });
  it('joins multi-line data with newlines', () => {
    assert.deepEqual(new SseParser().push('data: a\ndata: b\n\n'), [{ event: 'message', data: 'a\nb' }]);
  });
  it('ignores comments and fields it does not use', () => {
    assert.deepEqual(new SseParser().push(': ping\n\nid: 7\nretry: 5\nevent: x\ndata: 1\n\n'), [{ event: 'x', data: '1' }]);
  });
  it('handles chunks split anywhere', () => {
    const p = new SseParser();
    const text = 'event: trace\ndata: {"c":"x"}\n\nevent: resync\ndata: {}\n\n';
    const out = [...text].flatMap((ch) => p.push(ch));
    assert.deepEqual(out, [{ event: 'trace', data: '{"c":"x"}' }, { event: 'resync', data: '{}' }]);
  });
  it('handles CRLF, including a CRLF split across chunks', () => {
    const p = new SseParser();
    assert.deepEqual([...p.push('event: a\r'), ...p.push('\ndata: 1\r\n\r'), ...p.push('\n')], [{ event: 'a', data: '1' }]);
  });
  it('does not dispatch a block with no data line', () => {
    assert.deepEqual(new SseParser().push('event: lonely\n\n'), []);
  });
  it('keeps a trailing partial line until it completes', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: par'), []);
    assert.deepEqual(p.push('tial\n\n'), [{ event: 'message', data: 'partial' }]);
  });
  it('strips exactly one leading space from a value', () => {
    assert.deepEqual(new SseParser().push('data:  two\n\n'), [{ event: 'message', data: ' two' }]);
  });
});
