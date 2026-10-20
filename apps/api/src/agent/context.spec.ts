import { buildMessages } from './context';
import type { Step } from './types';

const conv = { customerName: 'Ava Brooks', customerEmail: 'ava.brooks@example.com' };
let n = 0;
const step = (s: Partial<Step> & Pick<Step, 'role'>): Step => ({
  id: ++n, runId: 'r', conversationId: 'c', content: null, toolName: null, toolArgs: null, toolCallId: null,
  result: null, latencyMs: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, createdAt: '', ...s,
});
const user = (content: string) => step({ role: 'user', content });
const answer = (content: string) => step({ role: 'assistant', content });
const call = (id: string, name = 'get_order') => step({ role: 'assistant', toolName: name, toolCallId: id, toolArgs: { orderId: 1 } });
const result = (id: string, name = 'get_order') => step({ role: 'tool', toolName: name, toolCallId: id, result: { ok: true } });
const big = (label: string) => `${label} ${'x'.repeat(4000)}`; // roughly 1000 tokens

describe('buildMessages', () => {
  it('rebuilds provider-ordered history: system, user, tool call(s) and results, answer', () => {
    const msgs = buildMessages(conv, [user('hi'), call('a'), call('b'), result('a'), result('b'), answer('done')]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(msgs[2].toolCalls?.map((c) => c.id)).toEqual(['a', 'b']); // both calls of one turn share one assistant message
    expect(msgs[0].content).toContain('Ava Brooks');
  });

  it('skips a dangling tool call from a crashed run so the history stays valid', () => {
    const msgs = buildMessages(conv, [user('hi'), call('lost'), user('again'), answer('ok')]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant']);
  });

  describe('with a context cap', () => {
    const history = () => [
      user(big('one')), call('1'), result('1'), answer('a1'),
      user(big('two')), call('2'), result('2'), answer('a2'),
      user(big('three')), call('3'), result('3'), answer('a3'),
      user(big('four')), call('4'), result('4'), answer('a4'),
      user(big('five')), call('5'),
    ];

    it('keeps only the newest turns that fit, and tells the model older ones were left out', () => {
      const msgs = buildMessages(conv, history(), 2500);
      const users = msgs.filter((m) => m.role === 'user').map((m) => m.content.split(' ')[0]);
      expect(users).toEqual(['four', 'five']);
      expect(msgs[0].content).toContain('3 earlier messages were left out');
    });

    it('never starts mid-turn: the first message after the system prompt is a user message, tool results always follow their call', () => {
      const msgs = buildMessages(conv, [...history(), result('5')], 2500);
      expect(msgs[1].role).toBe('user');
      const seen = new Set<string>();
      for (const m of msgs) {
        for (const c of m.toolCalls ?? []) seen.add(c.id);
        if (m.role === 'tool') expect(seen.has(m.toolCallId!)).toBe(true);
      }
    });

    it('always keeps the current turn, even if it alone exceeds the cap', () => {
      const msgs = buildMessages(conv, history(), 100);
      expect(msgs.filter((m) => m.role === 'user').map((m) => m.content.split(' ')[0])).toEqual(['five']);
    });

    it('adds no note and drops nothing when everything fits', () => {
      const msgs = buildMessages(conv, history(), 1_000_000);
      expect(msgs.filter((m) => m.role === 'user')).toHaveLength(5);
      expect(msgs[0].content).not.toContain('left out');
    });
  });
});

describe('buildMessages and blank assistant messages', () => {
  it('leaves out assistant messages with no text and no tool call, which providers reject', () => {
    const msgs = buildMessages(conv, [user('hi'), answer(''), user('hello?'), answer('hi there')]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant']);
  });
});
