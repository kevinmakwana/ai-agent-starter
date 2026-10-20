import type { AppConfig } from '../config';
import type { ApprovalExpiry } from './approval-expiry';
import { ApprovalExpiryScheduler } from './approval-expiry.scheduler';

const cfg = (approvalTtlMinutes: number) => ({ approvalTtlMinutes }) as AppConfig;
const idle = () => ({ expired: 0, failed: 0 });
const none = () => ({ recovered: 0, failed: 0 });
const expiry = (sweep: () => unknown, recoverStranded: () => unknown = async () => none()) =>
  ({ sweep, recoverStranded }) as unknown as ApprovalExpiry;

describe('ApprovalExpiryScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sweeps once a minute', async () => {
    const sweep = jest.fn(async () => idle());
    const s = new ApprovalExpiryScheduler(expiry(sweep), cfg(60));
    s.onModuleInit();
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(3);
    s.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(3); // stopped on shutdown
  });

  it('never starts a second sweep while the previous one is still running', async () => {
    let finish!: () => void;
    const sweep = jest.fn(() => new Promise<{ expired: number; failed: number }>((r) => (finish = () => r({ expired: 0, failed: 0 }))));
    const s = new ApprovalExpiryScheduler(expiry(sweep), cfg(60));
    s.onModuleInit();
    await jest.advanceTimersByTimeAsync(5 * 60_000); // five ticks while the first sweep is stuck
    expect(sweep).toHaveBeenCalledTimes(1);

    finish();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2); // free again
    s.onApplicationShutdown();
  });

  it('keeps sweeping after a sweep fails', async () => {
    const sweep = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ expired: 0, failed: 0 });
    const s = new ApprovalExpiryScheduler(expiry(sweep), cfg(60));
    s.onModuleInit();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    s.onApplicationShutdown();
  });

  it('also recovers decisions the process died in the middle of, even when expiry is disabled', async () => {
    const sweep = jest.fn(async () => idle());
    const recoverStranded = jest.fn(async () => none());
    const s = new ApprovalExpiryScheduler(expiry(sweep, recoverStranded), cfg(0));
    s.onModuleInit();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(recoverStranded).toHaveBeenCalledTimes(2);
    s.onApplicationShutdown();
  });

  it('keeps recovering when the expiry sweep fails', async () => {
    const recoverStranded = jest.fn(async () => none());
    const s = new ApprovalExpiryScheduler(expiry(async () => { throw new Error('db down'); }, recoverStranded), cfg(60));
    s.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(recoverStranded).toHaveBeenCalledTimes(1);
    s.onApplicationShutdown();
  });
});
