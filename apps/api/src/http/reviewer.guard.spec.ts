import { isReviewer } from './reviewer.guard';

describe('isReviewer', () => {
  it('is open when no key is configured (demo mode)', () => {
    expect(isReviewer('', undefined)).toBe(true);
  });

  it('requires the exact bearer key when configured', () => {
    expect(isReviewer('s3cret', 'Bearer s3cret')).toBe(true);
    expect(isReviewer('s3cret', 'Bearer s3cre')).toBe(false);
    expect(isReviewer('s3cret', 'Bearer s3crets')).toBe(false);
    expect(isReviewer('s3cret', 's3cret')).toBe(false); // missing scheme
    expect(isReviewer('s3cret', undefined)).toBe(false);
  });
});
