import { describe, expect, it } from 'vitest';
import { buttonVariants } from './button-variants';

describe('buttonVariants', () => {
	it('defaults to the primary (default) variant', () => {
		expect(buttonVariants()).toContain('bg-primary');
	});

	it('applies accent classes for the accent variant', () => {
		expect(buttonVariants({ variant: 'accent' })).toContain('bg-accent');
	});

	it('applies the lg size height', () => {
		expect(buttonVariants({ size: 'lg' })).toContain('h-12');
	});

	it('lets a custom class override the size via tailwind-merge', () => {
		const result = buttonVariants({ class: 'h-14' });
		expect(result).toContain('h-14');
		expect(result).not.toContain('h-10');
	});
});
