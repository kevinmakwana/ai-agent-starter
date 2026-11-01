import { budget } from './cases/budget';
import { approvalRouting } from './cases/approval-routing';
import { injection } from './cases/injection';
import { isolation } from './cases/isolation';
import { providerFailures } from './cases/provider-failures';
import { refusals } from './cases/refusals';
import { stateTransitions } from './cases/state-transitions';
import { toolChoice } from './cases/tool-choice';
import { CATEGORIES, checkExpectation, checkInvariants, runCase, type EvalCase } from './harness';

const ALL: EvalCase[] = [
  ...toolChoice,
  ...refusals,
  ...isolation,
  ...approvalRouting,
  ...stateTransitions,
  ...injection,
  ...providerFailures,
  ...budget,
];

describe('eval suite', () => {
  it('has unique case ids and every category is covered', () => {
    const ids = ALL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of CATEGORIES) expect(ALL.filter((c) => c.category === category).length).toBeGreaterThan(0);
  });

  for (const category of CATEGORIES) {
    describe(category, () => {
      for (const c of ALL.filter((x) => x.category === category)) {
        it(`${c.id}: ${c.description}`, async () => {
          const outcome = await runCase(c);
          // Expected outcomes first, then the invariants that hold after any case.
          expect(checkExpectation(c, outcome)).toEqual([]);
          expect(checkInvariants(outcome)).toEqual([]);
        });
      }
    });
  }
});
