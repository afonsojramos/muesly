<script lang="ts">
	import { Editor, Extension } from '@tiptap/core';
	import { Markdown } from '@tiptap/markdown';
	import { StarterKit } from '@tiptap/starter-kit';
	import { Plugin, PluginKey } from '@tiptap/pm/state';
	import { Decoration, DecorationSet } from '@tiptap/pm/view';
	import { onDestroy, onMount } from 'svelte';

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
		/** Fires on every edit with the current markdown. */
		onChange?: (markdown: string) => void;
	}

	let { value = '', editable = true, class: className, onChange }: Props = $props();

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

	function loadContent(markdown: string): void {
		if (!editor) return;
		lastValueProp = markdown;
		isProgrammatic = true;
		editor.commands.setContent(markdown, { contentType: 'markdown' });
		isProgrammatic = false;
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

<div bind:this={element} class={cn('tiptap-prose', className)}></div>

<style>
	.tiptap-prose :global(.ProseMirror) {
		outline: none;
		min-height: 8rem;
		line-height: 1.6;
		color: var(--color-foreground);
		/* Hide the native caret; the FixedCaret extension draws a text-sized one. */
		caret-color: transparent;
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
		left: 0;
		top: 50%;
		height: 1.15em;
		width: 1.5px;
		transform: translateY(-50%);
		/* The brand accent, nudged a bit darker for the caret. */
		background: color-mix(in oklab, var(--color-accent), black 15%);
		animation: fixed-caret-blink 1.1s steps(1, end) infinite;
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
		color: var(--color-accent);
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
