<script lang="ts">
	import { Editor } from '@tiptap/core';
	import { Markdown } from '@tiptap/markdown';
	import { StarterKit } from '@tiptap/starter-kit';
	import { onDestroy, onMount } from 'svelte';

	import { cn } from '$lib/utils';

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
			extensions: [StarterKit, Markdown],
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
		/* The text caret in a contenteditable is drawn at the line's line-height, so
		   a generous value makes the cursor look oversized next to the glyphs. 1.5
		   keeps prose readable while keeping the caret proportionate. */
		line-height: 1.5;
		color: var(--color-foreground);
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
