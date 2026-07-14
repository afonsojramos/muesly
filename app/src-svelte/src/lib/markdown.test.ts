import { describe, expect, it } from 'vitest';

import { externalHttpUrl, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('renders common Markdown without executable markup', () => {
		const html = renderMarkdown(
			'# Heading\n\nParagraph with **bold and *nested emphasis***.\n\n- one\n  - two\n\n1. first\n2. second\n\n> quote\n\n`inline`\n\n```ts\nconst safe = true;\n```',
		);

		expect(html).toContain('<h1>Heading</h1>');
		expect(html).toContain('<strong>bold and <em>nested emphasis</em></strong>');
		expect(html).toContain('<ul>');
		expect(html).toContain('<ol>');
		expect(html).toContain('<blockquote>');
		expect(html).toContain('<code>inline</code>');
		expect(html).toContain('<pre><code class="language-ts">');
	});

	it('escapes raw HTML and scripts', () => {
		const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');

		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('&lt;img');
	});

	it('keeps incomplete streaming Markdown safe and does not throw', () => {
		expect(() => renderMarkdown('Beginning **bold\n\n```ts\nconst x =')).not.toThrow();
		expect(renderMarkdown('Beginning **bold')).toContain('Beginning **bold');
	});

	it('only creates anchors for HTTP(S) links', () => {
		const html = renderMarkdown(
			'[secure](https://example.com/a) [plain](http://example.com) [relative](/local) [script](javascript:alert(1)) [bad](not a url)',
		);

		expect(html.match(/<a /g)).toHaveLength(2);
		expect(html).toContain('data-external-url="https://example.com/a"');
		expect(html).toContain('data-external-url="http://example.com/"');
		expect(html).not.toMatch(/<a[^>]+href=/);
		expect(html).not.toContain('javascript:');
	});

	it('escapes URL attributes without creating a navigation target', () => {
		const html = renderMarkdown('[safe](https://example.com/?first=1&second=%22quoted%22)');

		expect(html).toContain(
			'data-external-url="https://example.com/?first=1&amp;second=%22quoted%22"',
		);
		expect(html).not.toContain(' href=');
	});
});

describe('externalHttpUrl', () => {
	it.each([
		['https://example.com/path', 'https://example.com/path'],
		['http://example.com', 'http://example.com/'],
		['/relative', null],
		['javascript:alert(1)', null],
		['not a url', null],
	])('validates %s', (input, expected) => {
		expect(externalHttpUrl(input)).toBe(expected);
	});
});
