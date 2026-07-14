<script lang="ts">
	import { Editor, Extension } from '@tiptap/core';
	import { Markdown } from '@tiptap/markdown';
	import { StarterKit } from '@tiptap/starter-kit';
	import { Plugin, PluginKey } from '@tiptap/pm/state';
	import { Decoration, DecorationSet } from '@tiptap/pm/view';
	import { onDestroy, onMount } from 'svelte';

	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	// Fixed-size caret. A native contenteditable caret is always drawn at the line's
	// full line-height, so it looks oversized next to the glyphs and, depending on
	// the block, could span multiple lines. There's no CSS to size the native caret,
	// so we hide it (`caret-color: transparent`, in the styles below) and render our
	// own consistent, text-sized bar via a ProseMirror widget decoration at the
	// cursor. Keyed by position so it only re-renders (restarting the blink) when the
	// cursor actually moves.
	const FixedCaret = Extension.create({
		name: 'fixedCaret',
		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: new PluginKey('fixedCaret'),
					props: {
						decorations(state) {
							const { selection } = state;
							// Only a collapsed cursor gets a caret; a range uses the native highlight.
							if (!selection.empty) return null;
							const { head } = selection;
							return DecorationSet.create(state.doc, [
								Decoration.widget(
									head,
									() => {
										const el = document.createElement('span');
										el.className = 'fixed-caret';
										return el;
									},
									{ side: 0, key: `fixed-caret-${head}`, ignoreSelection: true },
								),
							]);
						},
					},
				}),
			];
		},
	});

	interface Props {
		/** Initial / external content as a markdown string. */
		value?: string;
		editable?: boolean;
		class?: string;
		/**
		 * Visual role of the document. `ai` uses muted foreground (Granola-style
		 * dual-color: AI gray, user notes default/black).
		 */
		tone?: 'user' | 'ai';
		/** Fires on every edit with the current markdown. */
		onChange?: (markdown: string) => void;
		/** Optional: click a `[mm:ss]` timestamp to jump to the transcript. */
		onTimestampClick?: (seconds: number) => void;
		/** Names offered when the user types `@` in the editor. */
		mentionSuggestions?: string[];
	}

	let {
		value = '',
		editable = true,
		class: className,
		tone = 'user',
		onChange,
		onTimestampClick,
		mentionSuggestions = [],
	}: Props = $props();

	// The TipTap Editor is a mutable, non-reactive object — keep it in a plain
	// variable (never $state) so its ProseMirror internals aren't proxied.
	let editor: Editor | undefined;
	let element = $state<HTMLDivElement>();
	// `ready` makes the effects below depend on the editor existing without
	// tracking the non-reactive `editor` variable itself.
	let ready = $state(false);
	// The last markdown *prop value* we pushed into the editor. Keyed off the
	// incoming prop only — never the editor's own serialized output — so the
	// reload guard can't be tripped by lossy markdown round-tripping.
	let lastValueProp = '';
	// Suppress onChange while we programmatically replace content (setContent
	// dispatches its transaction synchronously, so this flag brackets it).
	let isProgrammatic = false;
	let mentionRange = $state<{ from: number; to: number } | null>(null);
	let mentionQuery = $state('');
	let mentionIndex = $state(0);
	let mentionLeft = $state(0);
	let mentionTop = $state(0);
	const filteredMentions = $derived(
		mentionSuggestions
			.filter((name) => name.toLowerCase().includes(mentionQuery.toLowerCase()))
			.slice(0, 8),
	);

	function closeMentionMenu(): void {
		mentionRange = null;
		mentionQuery = '';
		mentionIndex = 0;
	}

	function updateMentionMenu(ed: Editor): void {
		if (!editable || mentionSuggestions.length === 0 || !ed.state.selection.empty) {
			closeMentionMenu();
			return;
		}

		const fromPosition = ed.state.selection.$from;
		const textBefore = fromPosition.parent.textBetween(0, fromPosition.parentOffset, '\0', '\0');
		const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/);
		if (!match) {
			closeMentionMenu();
			return;
		}

		const query = match[1] ?? '';
		const to = fromPosition.pos;
		mentionRange = { from: to - query.length - 1, to };
		mentionQuery = query;
		mentionIndex = 0;

		const caret = ed.view.coordsAtPos(to);
		const bounds = element?.getBoundingClientRect();
		if (bounds) {
			mentionLeft = Math.max(0, Math.min(caret.left - bounds.left, bounds.width - 256));
			mentionTop = caret.bottom - bounds.top + 6;
		}
	}

	function selectMention(name: string): void {
		if (!editor || !mentionRange) return;
		editor
			.chain()
			.focus()
			.deleteRange(mentionRange)
			.insertContent({
				type: 'text',
				text: `@${name}`,
				marks: [{ type: 'bold' }],
			})
			.insertContent(' ')
			.run();
		closeMentionMenu();
	}

	function handleMentionKeydown(event: KeyboardEvent): boolean {
		if (!mentionRange) return false;
		if (event.key === 'Escape') {
			closeMentionMenu();
			return true;
		}
		if (filteredMentions.length === 0) return false;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			const direction = event.key === 'ArrowDown' ? 1 : -1;
			mentionIndex = (mentionIndex + direction + filteredMentions.length) % filteredMentions.length;
			return true;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			const selectedMention = filteredMentions[mentionIndex];
			if (selectedMention) selectMention(selectedMention);
			return true;
		}
		return false;
	}

	function loadContent(markdown: string): void {
		if (!editor) return;
		lastValueProp = markdown;
		isProgrammatic = true;
		// Store plain markdown; timestamp tokens stay as `[mm:ss]` text (decorated
		// for clicks). Avoid HTML spans TipTap would strip.
		editor.commands.setContent(markdown, { contentType: 'markdown' });
		isProgrammatic = false;
	}

	/** Click handler: if the user clicked a `[mm:ss]` token, jump. */
	function handleProseClick(
		view: {
			posAtCoords: (c: { left: number; top: number }) => { pos: number } | null;
			state: { doc: { textBetween: (a: number, b: number) => string } };
		},
		event: MouseEvent,
	): boolean {
		if (!onTimestampClick) return false;
		const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
		if (!coords) return false;
		const { pos } = coords;
		// Expand a small window around the click to capture [mm:ss].
		const from = Math.max(0, pos - 8);
		const to = pos + 8;
		const around = view.state.doc.textBetween(from, to);
		const m = around.match(/\[(\d{1,2}):(\d{2})\]/);
		if (!m) return false;
		const seconds = Number(m[1]) * 60 + Number(m[2]);
		if (Number.isFinite(seconds)) {
			onTimestampClick(seconds);
			return true;
		}
		return false;
	}

	onMount(() => {
		if (!element) return;
		editor = new Editor({
			element,
			editable,
			extensions: [StarterKit, Markdown, FixedCaret],
			content: value,
			contentType: 'markdown',
			onUpdate: ({ editor: ed }) => {
				if (!isProgrammatic) onChange?.(ed.getMarkdown());
				updateMentionMenu(ed);
			},
			onSelectionUpdate: ({ editor: ed }) => updateMentionMenu(ed),
			onBlur: () => closeMentionMenu(),
			editorProps: {
				handleClick: (view, _pos, event) => handleProseClick(view, event),
				handleKeyDown: (_view, event) => handleMentionKeydown(event),
			},
		});
		lastValueProp = value;
		ready = true;
	});

	// Reactive editable — mutate the existing instance, never recreate it.
	$effect(() => {
		if (ready) editor?.setEditable(editable);
	});

	// Reload when the external value prop changes (e.g. summary regenerated).
	$effect(() => {
		if (ready && value !== lastValueProp) {
			loadContent(value);
		}
	});

	onDestroy(() => {
		editor?.destroy();
		editor = undefined;
	});

	export function getMarkdown(): string {
		return editor?.getMarkdown() ?? '';
	}

	export function getHTML(): string {
		return editor?.getHTML() ?? '';
	}

	export function setMarkdown(markdown: string): void {
		loadContent(markdown);
	}

	export function focus(): void {
		editor?.commands.focus();
	}
</script>

<div class="relative">
	<div
		bind:this={element}
		class={cn('tiptap-prose select-text', tone === 'ai' && 'tiptap-prose-ai', className)}
		onclick={(e) => {
			if (!onTimestampClick) return;
			const t = e.target;
			if (!(t instanceof HTMLElement)) return;
			const link = t.closest('[data-transcript-ts]');
			if (!(link instanceof HTMLElement)) return;
			e.preventDefault();
			const sec = Number(link.dataset.transcriptTs);
			if (Number.isFinite(sec)) onTimestampClick(sec);
		}}
		role="presentation"
	></div>

	{#if mentionRange}
		<div
			class="absolute z-50 w-64 rounded-lg bg-popover p-1 text-popover-foreground shadow-md"
			style:left={`${mentionLeft}px`}
			style:top={`${mentionTop}px`}
			role="listbox"
			aria-label="Tag a participant"
		>
			<p class="px-2 py-1.5 text-xs font-medium text-muted-foreground">Participants</p>
			{#if filteredMentions.length > 0}
				<div class="max-h-64 overflow-y-auto">
					{#each filteredMentions as name, index (name)}
						<Button
							variant="ghost"
							class={cn('h-10 w-full justify-start px-2', index === mentionIndex && 'bg-accent')}
							role="option"
							aria-selected={index === mentionIndex}
							onmousedown={(event) => {
								event.preventDefault();
								selectMention(name);
							}}
						>
							{name}
						</Button>
					{/each}
				</div>
			{:else}
				<p class="px-2 py-2 text-sm text-muted-foreground">No participants found.</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.tiptap-prose :global(.ProseMirror) {
		outline: none;
		min-height: 8rem;
		line-height: 1.6;
		color: var(--color-foreground);
		/* Hide the native caret; the FixedCaret extension draws a text-sized one. */
		caret-color: transparent;
	}

	/* AI-generated body: muted gray; user notes keep default foreground. */
	.tiptap-prose-ai :global(.ProseMirror) {
		color: var(--color-muted-foreground);
	}
	.tiptap-prose-ai :global(.ProseMirror strong),
	.tiptap-prose-ai :global(.ProseMirror h1),
	.tiptap-prose-ai :global(.ProseMirror h2),
	.tiptap-prose-ai :global(.ProseMirror h3) {
		color: var(--color-foreground);
	}

	/* Custom caret: a thin bar sized to the text (1.15em) and vertically centred on
	   the line, so it stays the same modest height regardless of line-height or block
	   type. Only shown while the editor is focused. */
	.tiptap-prose :global(.ProseMirror .fixed-caret) {
		position: relative;
	}
	.tiptap-prose :global(.ProseMirror .fixed-caret::after) {
		content: '';
		position: absolute;
		left: -1px;
		top: 50%;
		height: 1.15em;
		width: 1.5px;
		transform: translateY(-50%);
		/* The brand accent, nudged a bit darker for the caret. */
		background: color-mix(in oklab, var(--color-brand), black 15%);
		animation: fixed-caret-blink 1.1s steps(1, end) infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		.tiptap-prose :global(.ProseMirror .fixed-caret::after) {
			animation: none;
		}
	}
	.tiptap-prose :global(.ProseMirror:not(:focus) .fixed-caret::after) {
		display: none;
	}
	:global {
		@keyframes fixed-caret-blink {
			0%,
			50% {
				opacity: 1;
			}
			50.01%,
			100% {
				opacity: 0;
			}
		}
	}
	.tiptap-prose :global(.ProseMirror > * + *) {
		margin-top: 0.75em;
	}
	.tiptap-prose :global(.ProseMirror h1) {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 1.25;
	}
	.tiptap-prose :global(.ProseMirror h2) {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1.3;
	}
	.tiptap-prose :global(.ProseMirror h3) {
		font-family: var(--font-display);
		font-size: 1.05rem;
		font-weight: 600;
	}
	.tiptap-prose :global(.ProseMirror ul),
	.tiptap-prose :global(.ProseMirror ol) {
		list-style: none;
		padding-left: 1.5rem;
	}
	/* Render list items as plain blocks with a pseudo-element marker rather than a
	   native `display: list-item` box. A list-item <li> makes Blink draw the text
	   caret at the FULL (multi-line) height of the item, so a wrapped bullet shows a
	   caret several lines tall. Dropping list-item removes that caret geometry — the
	   cursor then anchors to the paragraph text like any other block. Same fix used
	   by the Skiff and CZI ProseMirror editors. */
	.tiptap-prose :global(.ProseMirror li) {
		display: block;
		list-style: none;
		position: relative;
	}
	.tiptap-prose :global(.ProseMirror li > p) {
		margin: 0;
	}
	.tiptap-prose :global(.ProseMirror ul > li::before) {
		content: '•';
		position: absolute;
		left: -1.1rem;
	}
	.tiptap-prose :global(.ProseMirror ol) {
		counter-reset: ol-counter;
	}
	.tiptap-prose :global(.ProseMirror ol > li) {
		counter-increment: ol-counter;
	}
	.tiptap-prose :global(.ProseMirror ol > li::before) {
		content: counter(ol-counter) '.';
		position: absolute;
		left: -1.4rem;
	}
	.tiptap-prose :global(.ProseMirror a) {
		color: var(--color-brand);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.tiptap-prose :global(.ProseMirror blockquote) {
		border-left: 3px solid var(--color-border);
		padding-left: 1rem;
		color: var(--color-muted-foreground);
	}
	.tiptap-prose :global(.ProseMirror code) {
		background: var(--color-secondary);
		border-radius: 0.25rem;
		padding: 0.1em 0.35em;
		font-size: 0.875em;
	}
	.tiptap-prose :global(.ProseMirror pre) {
		background: var(--color-secondary);
		border-radius: 0.5rem;
		padding: 0.75rem 1rem;
		overflow-x: auto;
	}
	.tiptap-prose :global(.ProseMirror pre code) {
		background: none;
		padding: 0;
	}
	.tiptap-prose :global(.ProseMirror hr) {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: 1.5em 0;
	}
</style>
