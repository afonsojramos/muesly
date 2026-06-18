import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
	it('merges conflicting tailwind classes so the last wins', () => {
		expect(cn('p-2', 'p-4')).toBe('p-4');
	});

	it('drops falsy values', () => {
		expect(cn('a', false && 'b', undefined, 'c')).toBe('a c');
	});
});
