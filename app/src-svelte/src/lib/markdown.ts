import { marked, Renderer } from 'marked';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export function externalHttpUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
}

const renderer = new Renderer();

// Model output is never trusted as HTML. Marked escapes ordinary text itself;
// this override also turns raw HTML blocks/spans into literal, visible text.
renderer.html = ({ text }) => escapeHtml(text);
renderer.image = ({ text }) => escapeHtml(text);
renderer.link = ({ href, tokens }) => {
	const label = renderer.parser.parseInline(tokens);
	const safeUrl = externalHttpUrl(href);
	if (!safeUrl) return label;
	return `<a href="${escapeHtml(safeUrl)}" data-external-url="${escapeHtml(safeUrl)}">${label}</a>`;
};

export function renderMarkdown(markdown: string): string {
	return marked.parse(markdown, { async: false, gfm: true, breaks: false, renderer });
}
