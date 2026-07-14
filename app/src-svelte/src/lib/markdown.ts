import { Marked, Renderer, type MarkedExtension } from 'marked';

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

function createRenderer(): Renderer {
	const renderer = new Renderer();
	// Model output is never trusted as HTML. Marked escapes ordinary text itself;
	// this override also turns raw HTML blocks/spans into literal, visible text.
	renderer.html = ({ text }) => escapeHtml(text);
	renderer.image = ({ text }) => escapeHtml(text);
	renderer.link = function ({ href, tokens }) {
		const label = this.parser.parseInline(tokens);
		const safeUrl = externalHttpUrl(href);
		if (!safeUrl) return label;
		return `<a role="link" tabindex="0" data-external-url="${escapeHtml(safeUrl)}">${label}</a>`;
	};
	return renderer;
}

const transcriptTimestampExtension: MarkedExtension = {
	extensions: [
		{
			name: 'transcriptTimestamp',
			level: 'inline',
			start(src: string) {
				return src.search(/\[\d{1,}:\d{2}\]/);
			},
			tokenizer(src: string) {
				const match = /^\[(\d{1,}):([0-5]\d)\]/.exec(src);
				if (!match) return undefined;
				return {
					type: 'transcriptTimestamp',
					raw: match[0],
					label: match[0],
					seconds: Number(match[1]) * 60 + Number(match[2]),
				};
			},
			renderer(token) {
				const timestamp = token as typeof token & { label: string; seconds: number };
				return `<button type="button" class="transcript-timestamp" data-transcript-seconds="${timestamp.seconds}" aria-label="Jump to transcript at ${escapeHtml(timestamp.label)}">${escapeHtml(timestamp.label)}</button>`;
			},
		},
	],
};

const standardMarkdown = new Marked({ renderer: createRenderer() });
const timestampMarkdown = new Marked({ renderer: createRenderer() }, transcriptTimestampExtension);

export function renderMarkdown(markdown: string, linkTranscriptTimestamps = false): string {
	const parser = linkTranscriptTimestamps ? timestampMarkdown : standardMarkdown;
	return parser.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
}
