import { describe, expect, it } from 'vitest';

import { barCommandSlug, barCommandSlugs, type Bar } from './catalog';

function bar(id: string, title: string): Bar {
	return {
		id,
		title,
		description: '',
		prompt: '',
		scenarios: ['after'],
		icon: 'sparkles',
		source: 'builtin',
	};
}

describe('barCommandSlug', () => {
	it('uses the stable catalog id for built-in commands', () => {
		expect(barCommandSlug(bar('builtin:recent-todos', 'Recent to-dos'))).toBe('recent-todos');
	});

	it('normalizes user bar titles into typeable commands', () => {
		expect(barCommandSlug(bar('user-entry', 'Résumé & Next Steps'))).toBe('resume-next-steps');
	});

	it('provides a deterministic fallback for titles without latin characters', () => {
		expect(barCommandSlug(bar('user-unicode', '進捗 ✨'))).toMatch(/^bar-[a-z0-9]+$/);
		expect(barCommandSlug(bar('user-unicode', '進捗 ✨'))).toBe(
			barCommandSlug(bar('user-unicode', '進捗 ✨')),
		);
	});

	it('disambiguates duplicate user commands deterministically', () => {
		const first = bar('user-one', 'Project recap');
		const second = bar('user-two', 'Project recap');
		const slugs = barCommandSlugs([first, second]);
		expect(slugs.get(first.id)).toMatch(/^project-recap-[a-z0-9]+$/);
		expect(slugs.get(second.id)).toMatch(/^project-recap-[a-z0-9]+$/);
		expect(slugs.get(first.id)).not.toBe(slugs.get(second.id));
	});
});
