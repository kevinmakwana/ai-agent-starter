import { assertValidMigrationList, checksum, planMigrations, type AppliedMigration } from './migrate';
import { MIGRATIONS, type Migration } from './migrations';

const m = (version: number, name = `m${version}`, sql = `SELECT ${version}`): Migration => ({ version, name, sql });
const applied = (...list: Migration[]): AppliedMigration[] =>
  list.map((x) => ({ version: x.version, name: x.name, checksum: checksum(x.sql) }));

describe('planMigrations', () => {
  const known = [m(1), m(2), m(3)];

  it('plans everything for a database that was never migrated', () => {
    expect(planMigrations([], known).pending.map((x) => x.version)).toEqual([1, 2, 3]);
  });

  it('plans only what is not yet applied, in order', () => {
    expect(planMigrations(applied(known[0]), known).pending.map((x) => x.version)).toEqual([2, 3]);
    expect(planMigrations(applied(...known), known).pending).toEqual([]);
  });

  it('refuses a migration whose text changed after it was applied', () => {
    const edited = [m(1, 'm1', 'SELECT 1 /* edited */'), m(2), m(3)];
    expect(() => planMigrations(applied(known[0]), edited)).toThrow('was changed after it was applied');
  });

  it('refuses a migration that was renamed after it was applied', () => {
    expect(() => planMigrations(applied(known[0]), [m(1, 'renamed'), m(2), m(3)])).toThrow('was changed after it was applied');
  });

  it('refuses a hole in the history', () => {
    expect(() => planMigrations(applied(known[0], known[2]), known)).toThrow('Migration 2 (m2) is missing');
  });

  it('reports versions it does not know instead of failing, so an older build can still start after a newer one migrated', () => {
    const plan = planMigrations([...applied(...known), { version: 4, name: 'from-the-future', checksum: 'x' }], known);
    expect(plan).toEqual({ pending: [], unknown: [4] });
  });
});

describe('assertValidMigrationList', () => {
  it('accepts the real list', () => {
    expect(() => assertValidMigrationList(MIGRATIONS)).not.toThrow();
  });

  it.each([
    ['a gap', [m(1), m(3)]],
    ['a duplicate', [m(1), m(1)]],
    ['a wrong order', [m(2), m(1)]],
    ['not starting at 1', [m(2)]],
    ['a name that is not a slug', [m(1, 'Has Spaces')]],
    ['an empty body', [m(1, 'empty', '  ')]],
  ])('rejects %s', (_why, list) => {
    expect(() => assertValidMigrationList(list)).toThrow();
  });
});

describe('released migrations are frozen', () => {
  // If this fails you edited a released migration. Databases that applied it will refuse to start (the checksum is verified).
  // Add a new migration instead; only when a migration has never been released may you update its checksum here.
  it('the baseline text is unchanged', () => {
    expect(checksum(MIGRATIONS[0].sql)).toBe('e76b7d102c4ee1be673f7f2264f7a8065c82c229f1ac4047d588311e3f98d57b');
  });
});
