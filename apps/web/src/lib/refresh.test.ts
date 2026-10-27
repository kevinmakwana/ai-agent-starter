import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLatest, singleFlight } from './refresh';

/** A promise the test resolves by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createLatest', () => {
  it('only the most recently started request is current', () => {
    const latest = createLatest();
    const a = latest.next();
    assert.equal(a(), true);
    const b = latest.next();
    assert.equal(a(), false);
    assert.equal(b(), true);
    const c = latest.next();
    assert.deepEqual([a(), b(), c()], [false, false, true]);
  });

  it('keeps an out-of-order older response from overwriting a newer one', async () => {
    const latest = createLatest();
    let shown = '';
    const load = async (label: string, gate: Promise<void>) => {
      const current = latest.next();
      await gate;
      if (current()) shown = label;
    };
    const slow = deferred();
    const fast = deferred();
    const first = load('old', slow.promise);
    const second = load('new', fast.promise);
    fast.resolve();
    await second;
    slow.resolve();
    await first;
    assert.equal(shown, 'new');
  });
});

describe('singleFlight', () => {
  const or = (a: boolean, b: boolean) => a || b;

  it('runs once for a lone call', async () => {
    const calls: boolean[] = [];
    const run = singleFlight(async (skip: boolean) => { calls.push(skip); }, or);
    await run(true);
    assert.deepEqual(calls, [true]);
  });

  it('never overlaps, and a burst during a run collapses into one trailing run', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const run = singleFlight(async (_: boolean) => {
      const gate = gates[started++]!;
      active++; maxActive = Math.max(maxActive, active);
      await gate.promise;
      active--;
    }, or);

    const first = run(false);
    await tick();
    assert.equal(started, 1);
    const burst = [run(false), run(false), run(false), run(false)];
    await tick();
    assert.equal(started, 1, 'no overlapping run');

    gates[0]!.resolve();
    await tick();
    assert.equal(started, 2, 'exactly one trailing run');
    gates[1]!.resolve();
    await Promise.all([first, ...burst]);
    assert.equal(started, 2);
    assert.equal(maxActive, 1);
  });

  it('merges the arguments of queued calls, so a queued detail refresh is not lost to a later skipDetail one', async () => {
    const seen: boolean[] = [];
    const gate = deferred();
    let n = 0;
    const run = singleFlight(async (skipDetail: boolean) => {
      seen.push(skipDetail);
      if (n++ === 0) await gate.promise;
    }, (queued, next) => queued && next); // skipDetail only if every queued call skips it
    const first = run(true);
    await tick();
    void run(false); // wants detail
    const last = run(true); // does not
    gate.resolve();
    await Promise.all([first, last]);
    assert.deepEqual(seen, [true, false]);
  });

  it('a call made after the loop finished starts a fresh run', async () => {
    let runs = 0;
    const run = singleFlight(async (_: boolean) => { runs++; }, or);
    await run(false);
    await run(false);
    assert.equal(runs, 2);
  });

  it('recovers after fn throws: the next call runs again', async () => {
    let runs = 0;
    const run = singleFlight(async (_: boolean) => { if (runs++ === 0) throw new Error('boom'); }, or);
    await assert.rejects(run(false), /boom/);
    await run(false);
    assert.equal(runs, 2);
  });
});
