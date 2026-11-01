import { runWithRequestId } from './request-context';
import { type LogFormat, StructuredLogger } from './structured-logger';

const capture = (format: LogFormat) => {
  const out: string[] = [];
  const err: string[] = [];
  return { logger: new StructuredLogger(format, { out: (l) => out.push(l), err: (l) => err.push(l) }), out, err };
};

describe('StructuredLogger (json)', () => {
  it('writes one parseable object per event with level, context and message', () => {
    const { logger, out } = capture('json');
    logger.log('API started', 'Bootstrap');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ level: 'log', context: 'Bootstrap', msg: 'API started' });
    expect(JSON.parse(out[0]).time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('adds the id of the request being served, and none outside a request', () => {
    const { logger, out } = capture('json');
    runWithRequestId('req-12345678', () => logger.warn('inside', 'X'));
    logger.warn('outside', 'X');
    expect(JSON.parse(out[0]).requestId).toBe('req-12345678');
    expect(JSON.parse(out[1])).not.toHaveProperty('requestId');
  });

  it('keeps the id across awaits inside the request', async () => {
    const { logger, out } = capture('json');
    await runWithRequestId('req-abcdefgh', async () => {
      await new Promise((r) => setTimeout(r, 5));
      logger.log('later', 'X');
    });
    expect(JSON.parse(out[0]).requestId).toBe('req-abcdefgh');
  });

  it('sends errors to the error stream, with the stack as its own field', () => {
    const { logger, out, err } = capture('json');
    logger.error('boom', 'Error: boom\n    at x (file.ts:1:1)', 'Upstream');
    expect(out).toHaveLength(0);
    expect(JSON.parse(err[0])).toMatchObject({ level: 'error', context: 'Upstream', msg: 'boom', stack: expect.stringContaining('at x') });
  });

  it('spreads an object message into fields, and replaces credential-looking keys at any depth', () => {
    const { logger, out } = capture('json');
    logger.log(
      { msg: 'request', method: 'GET', headers: { Authorization: 'Bearer SECRET', cookie: 'session=SECRET', ok: 'yes' }, apiKey: 'SECRET' },
      'Http',
    );
    const line = JSON.parse(out[0]);
    expect(line).toMatchObject({
      msg: 'request',
      method: 'GET',
      headers: { Authorization: '[redacted]', cookie: '[redacted]', ok: 'yes' },
      apiKey: '[redacted]',
    });
    expect(out[0]).not.toContain('SECRET');
  });

  it('does not let a field overwrite the level, time or message', () => {
    const { logger, out } = capture('json');
    logger.log({ msg: 'real', level: 'fatal', time: 'never', context: 'spoof' }, 'Http');
    expect(JSON.parse(out[0])).toMatchObject({ level: 'log', context: 'Http', msg: 'real' });
    expect(JSON.parse(out[0]).time).not.toBe('never');
  });

  it('cannot be made to write a second line by a message with newlines', () => {
    const { logger, out } = capture('json');
    logger.log('first\n{"level":"error","msg":"forged"}', 'X');
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain('\n');
    expect(JSON.parse(out[0]).msg).toContain('forged'); // it is data inside msg, not a record
    expect(JSON.parse(out[0]).level).toBe('log');
  });

  it('bounds the size of a message', () => {
    const { logger, out } = capture('json');
    logger.log('x'.repeat(50_000), 'X');
    expect(out[0].length).toBeLessThan(2500);
  });

  it('logs an Error given as the message', () => {
    const { logger, err } = capture('json');
    logger.error(new Error('failed thing'), undefined, 'X');
    expect(JSON.parse(err[0]).msg).toBe('failed thing');
  });
});

describe('StructuredLogger (pretty)', () => {
  it('writes a readable single line with context, short request id and fields', () => {
    const { logger, out } = capture('pretty');
    runWithRequestId('abcdefgh-1111-2222', () => logger.log({ msg: 'request', status: 200 }, 'Http'));
    expect(out[0]).toMatch(/LOG\s+\[Http\] \(abcdefgh\) request \{"status":200\}$/);
  });

  it('keeps a multi-line message on one line', () => {
    const { logger, out } = capture('pretty');
    logger.log('a\nb', 'X');
    expect(out[0].split('\n')).toHaveLength(1);
  });
});
