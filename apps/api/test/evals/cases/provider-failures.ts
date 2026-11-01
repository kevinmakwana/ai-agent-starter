import { call, say, wireToolUse, type EvalCase } from '../harness';

// "wire" turns are recorded Anthropic replies run through the real adapter, so the truncation and parsing rules are the real ones.
export const providerFailures: EvalCase[] = [
  {
    id: 'truncated-tool-call-is-never-executed',
    category: 'provider-failures',
    description: 'A refund tool_use cut off at the token limit fails the run before anything is parked or paid',
    model: [wireToolUse('t1', 'issue_refund', { orderId: 1, amount: 5 }, 'max_tokens')],
    script: [{ user: 'refund order 1' }],
    expect: { errors: ['UpstreamLlmError'], runStatus: 'failed', toolCalls: [], refunds: [], actions: [] },
  },
  {
    id: 'provider-server-error-fails-the-run-cleanly',
    category: 'provider-failures',
    description: 'An HTTP 500 from the provider fails the run with no side effects',
    model: [{ wire: { status: 500, body: { error: { message: 'internal error with secret details' } } } }],
    script: [{ user: 'refund order 1' }],
    expect: { errors: ['UpstreamLlmError'], runStatus: 'failed', refunds: [], actions: [], neverInTrace: ['secret details'] },
  },
  {
    id: 'provider-reply-without-content',
    category: 'provider-failures',
    description: 'A 200 whose body has no content is treated as a failed call',
    model: [{ wire: { body: { id: 'msg_1', type: 'message', role: 'assistant' } } }],
    script: [{ user: 'hello' }],
    expect: { errors: ['UpstreamLlmError'], runStatus: 'failed' },
  },
  {
    id: 'provider-refuses',
    category: 'provider-failures',
    description: 'A refusal stop reason is a failed call, not an empty answer',
    model: [{ wire: { body: { content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } } } }],
    script: [{ user: 'hello' }],
    expect: { errors: ['UpstreamLlmError'], runStatus: 'failed' },
  },
  {
    id: 'a-recorded-reply-drives-a-normal-tool-call',
    category: 'provider-failures',
    description: 'A well-formed recorded tool_use reply goes through the adapter and the loop like any other call',
    model: [
      wireToolUse('t1', 'get_order', { orderId: 1 }),
      {
        wire: {
          body: {
            content: [{ type: 'text', text: 'Order 1 is delivered.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 50, output_tokens: 8 },
          },
        },
      },
    ],
    script: [{ user: "what's the status of order 1" }],
    expect: { runStatus: 'completed', toolCalls: ['get_order'], modelCalls: 2, finalMessageContains: ['delivered'] },
  },
  {
    id: 'empty-model-reply-is-not-stored-as-an-answer',
    category: 'provider-failures',
    description: 'A reply with no text and no tool call fails the run; no blank assistant message is kept',
    model: [{ completion: { toolCalls: [], usage: { inputTokens: 100, outputTokens: 0 } } }],
    script: [{ user: 'hello' }],
    expect: { runStatus: 'failed' },
  },
  {
    id: 'the-conversation-recovers-after-a-provider-error',
    category: 'provider-failures',
    description: 'After a failed run the next message is accepted and answered',
    model: [{ wire: { status: 503, body: { error: 'overloaded' } } }, say('Hello again.')],
    script: [{ user: 'hello' }, { user: 'hello?' }],
    expect: { errors: ['UpstreamLlmError'], runStatus: 'completed', modelCalls: 2, finalMessageContains: ['Hello again'] },
  },
  {
    id: 'a-model-that-never-stops-calling-tools',
    category: 'provider-failures',
    description: 'The step limit ends a looping model and the run says so',
    model: [call('x', 'get_order', { orderId: 1 })],
    maxSteps: 3,
    script: [{ user: 'hi' }],
    expect: { runStatus: 'step_limit', modelCalls: 3, finalMessageContains: ['3 steps'] },
  },
];
