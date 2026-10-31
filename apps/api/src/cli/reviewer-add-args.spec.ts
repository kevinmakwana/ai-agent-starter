import { parseReviewerAddArgs, resolvePassword } from './reviewer-add-args';

describe('parseReviewerAddArgs', () => {
  it('reads email and name, defaulting the role to admin and lower-casing the email', () => {
    expect(parseReviewerAddArgs(['--email', 'You@Example.com', '--name', 'You Person'])).toEqual({ email: 'you@example.com', name: 'You Person', role: 'admin' });
    expect(parseReviewerAddArgs(['--email=a@b.co', '--name=A', '--role=reviewer'])).toEqual({ email: 'a@b.co', name: 'A', role: 'reviewer' });
  });

  it('refuses a password on the command line in any spelling (it would land in shell history)', () => {
    for (const flag of [['--password', 'hunter2hunter2'], ['--password=hunter2hunter2'], ['--pass', 'x'], ['-p', 'x']]) {
      expect(() => parseReviewerAddArgs(['--email', 'a@b.co', '--name', 'A', ...flag])).toThrow(/REVIEWER_PASSWORD/);
    }
  });

  it('requires a valid email and a name, a known role, and no stray arguments', () => {
    expect(() => parseReviewerAddArgs(['--name', 'A'])).toThrow(/--email/);
    expect(() => parseReviewerAddArgs(['--email', 'a@b.co'])).toThrow(/--name/);
    expect(() => parseReviewerAddArgs(['--email', 'nope', '--name', 'A'])).toThrow(/valid email/);
    expect(() => parseReviewerAddArgs(['--email', 'a@b.co', '--name', ''])).toThrow(/--name/);
    expect(() => parseReviewerAddArgs(['--email', 'a@b.co', '--name', 'A', '--role', 'owner'])).toThrow(/admin or reviewer/);
    expect(() => parseReviewerAddArgs(['--email', 'a@b.co', '--name', 'A', '--wat'])).toThrow(/Unknown/);
    expect(() => parseReviewerAddArgs(['--email', 'a@b.co', '--name'])).toThrow(/--name/);
  });
});

describe('resolvePassword', () => {
  it('prefers REVIEWER_PASSWORD and checks the length', () => {
    expect(resolvePassword({ REVIEWER_PASSWORD: 'correct horse battery' })).toBe('correct horse battery');
    expect(() => resolvePassword({ REVIEWER_PASSWORD: 'short' })).toThrow(/at least 12/);
    expect(() => resolvePassword({ REVIEWER_PASSWORD: 'x'.repeat(201) })).toThrow(/at most 200/);
  });

  it('returns null when it must be prompted for', () => {
    expect(resolvePassword({})).toBeNull();
    expect(resolvePassword({ REVIEWER_PASSWORD: '' })).toBeNull();
  });
});
