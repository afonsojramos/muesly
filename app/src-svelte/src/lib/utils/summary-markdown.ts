/**
 * Summary → markdown normalization.
 *
 * Markdown is the canonical, durable summary format: the Rust backend generates
 * `{ markdown }` and always persists it. The old BlockNote `summary_json` blocks
 * are dropped with BlockNote, and the custom section/block ("legacy") JSON is
 * deprecated. This helper collapses any stored shape down to a single markdown
 * string so the prose editor only ever deals with markdown.
 */

import type { Block, Section, Summary, SummaryDataResponse } from '$lib/types';

const RESERVED_KEYS = new Set(['markdown', 'summary_json', 'MeetingName', '_section_order']);

function isSection(value: unknown): value is Section {
	return typeof value === 'object' && value !== null && Array.isArray((value as Section).blocks);
}

function blockToMarkdown(block: Block): string {
	const content = typeof block?.content === 'string' ? block.content : '';
	switch (block?.type) {
		case 'heading1':
			return `### ${content}\n\n`;
		case 'heading2':
			return `#### ${content}\n\n`;
		case 'bullet':
			return `- ${content}\n`;
		default:
			return `${content}\n\n`;
	}
}

function legacySectionsToMarkdown(sections: [string, Section][]): string {
	let markdown = '';
	for (const [key, section] of sections) {
		markdown += `## ${section.title || key}\n\n`;
		for (const block of section.blocks) {
			markdown += blockToMarkdown(block);
		}
		if (section.blocks.some((b) => b.type === 'bullet')) {
			markdown += '\n';
		}
	}
	return markdown.trimEnd();
}

/**
 * Reduce any stored summary shape to a markdown string.
 * Returns an empty string when there is no usable content.
 *
 * Note: legacy section ordering follows object key order; the deprecated
 * `_section_order` hint is not honored (these rows are read-only back-compat).
 */
export function summaryToMarkdown(data: SummaryDataResponse | Summary | null): string {
	if (!data) return '';

	// Canonical markdown (the durable backend format).
	if ('markdown' in data && typeof data.markdown === 'string') return data.markdown;

	// Back-compat: convert legacy section/block JSON to markdown.
	const sections = Object.entries(data).filter(
		(entry): entry is [string, Section] => !RESERVED_KEYS.has(entry[0]) && isSection(entry[1]),
	);

	return sections.length > 0 ? legacySectionsToMarkdown(sections) : '';
}

/** True when the stored summary contains any renderable content. */
export function summaryHasContent(data: SummaryDataResponse | Summary | null): boolean {
	return summaryToMarkdown(data).trim().length > 0;
}
