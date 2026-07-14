<script lang="ts">
	import { commands } from '$lib/bindings';
	import { renderMarkdown } from '$lib/markdown';
	import { toast } from '$lib/toast';

	interface Props {
		value: string;
		/** Optional interception point for future message-specific link actions. */
		onLinkClick?: (url: string) => boolean | void;
		/** Turns recording-relative `[mm:ss]` tokens into transcript jumps. */
		onTimestampClick?: (seconds: number) => void;
	}

	let { value, onLinkClick, onTimestampClick }: Props = $props();
	const html = $derived(renderMarkdown(value, Boolean(onTimestampClick)));

	async function activateLink(event: MouseEvent | KeyboardEvent): Promise<void> {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const timestamp = target.closest<HTMLElement>('[data-transcript-seconds]');
		if (timestamp) {
			event.preventDefault();
			const seconds = Number(timestamp.dataset.transcriptSeconds);
			if (onTimestampClick && Number.isFinite(seconds)) onTimestampClick(seconds);
			return;
		}
		const anchor = target.closest<HTMLAnchorElement>('a[data-external-url]');
		if (!anchor) return;
		event.preventDefault();
		const url = anchor.dataset.externalUrl;
		if (!url || onLinkClick?.(url) === true) return;
		const result = await commands.openExternalUrl(url);
		if (result.status === 'error') {
			toast.error('Could not open link', { description: result.error });
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		void activateLink(event);
	}
</script>

<!-- The helper emits only parser-generated markup, escapes raw HTML, and removes
     non-HTTP links before this reaches the DOM. -->
<!-- svelte-ignore a11y_no_static_element_interactions click delegation avoids a handler per streamed link -->
<div class="markdown-content" onclick={(event) => void activateLink(event)} onkeydown={onKeydown}>
	{@html html}
</div>

<style>
	.markdown-content {
		line-height: 1.5;
	}
	.markdown-content :global(> * + *) {
		margin-top: 0.75rem;
	}
	.markdown-content :global(h1),
	.markdown-content :global(h2),
	.markdown-content :global(h3),
	.markdown-content :global(h4),
	.markdown-content :global(h5),
	.markdown-content :global(h6) {
		font-weight: 600;
		line-height: 1.25;
	}
	.markdown-content :global(h1) {
		font-size: 1.25rem;
	}
	.markdown-content :global(h2) {
		font-size: 1.125rem;
	}
	.markdown-content :global(ul),
	.markdown-content :global(ol) {
		padding-left: 1.25rem;
	}
	.markdown-content :global(ul) {
		list-style: disc;
	}
	.markdown-content :global(ol) {
		list-style: decimal;
	}
	.markdown-content :global(li > ul),
	.markdown-content :global(li > ol) {
		margin-top: 0.25rem;
	}
	.markdown-content :global(blockquote) {
		border-left: 2px solid var(--color-border);
		padding-left: 0.75rem;
		color: var(--color-muted-foreground);
	}
	.markdown-content :global(code) {
		border-radius: 0.25rem;
		background: var(--color-muted);
		padding: 0.125rem 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.875em;
	}
	.markdown-content :global(pre) {
		overflow-x: auto;
		border-radius: 0.5rem;
		background: var(--color-muted);
		padding: 0.75rem;
	}
	.markdown-content :global(pre code) {
		background: transparent;
		padding: 0;
	}
	.markdown-content :global(a) {
		color: var(--color-primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.markdown-content :global(.transcript-timestamp) {
		cursor: pointer;
		border: 0;
		background: transparent;
		padding: 0;
		color: var(--color-primary);
		font: inherit;
		font-variant-numeric: tabular-nums;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.markdown-content :global(.transcript-timestamp:focus-visible) {
		border-radius: 0.125rem;
		outline: 2px solid var(--color-ring);
		outline-offset: 2px;
	}
</style>
