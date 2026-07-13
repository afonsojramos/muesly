import { describe, expect, it } from 'vitest';
import { comparisons } from './comparisons';

const MAX_REVIEW_AGE_DAYS = 120;

describe('comparison content', () => {
	it('is reviewed on a freshness cadence', () => {
		for (const comparison of comparisons) {
			const reviewed = new Date(`${comparison.reviewedAt}T00:00:00Z`).getTime();
			const ageDays = (Date.now() - reviewed) / 86_400_000;
			expect(
				ageDays,
				`${comparison.slug} was last reviewed ${Math.floor(ageDays)} days ago`,
			).toBeLessThanOrEqual(MAX_REVIEW_AGE_DAYS);
			expect(ageDays, `${comparison.slug} review date is in the future`).toBeGreaterThanOrEqual(-1);
		}
	});

	it('links every comparison to multiple official HTTPS sources', () => {
		for (const comparison of comparisons) {
			expect(comparison.sources.length).toBeGreaterThanOrEqual(2);
			for (const source of comparison.sources) expect(source.href).toMatch(/^https:\/\//);
		}
	});
});
