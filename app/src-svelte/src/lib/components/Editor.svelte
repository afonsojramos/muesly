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
			}
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
		line-height: 1.7;
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
		padding-left: 1.5rem;
	}
	.tiptap-prose :global(.ProseMirror ul) {
		list-style: disc;
	}
	.tiptap-prose :global(.ProseMirror ol) {
		list-style: decimal;
	}
	.tiptap-prose :global(.ProseMirror li > p) {
		margin: 0;
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
