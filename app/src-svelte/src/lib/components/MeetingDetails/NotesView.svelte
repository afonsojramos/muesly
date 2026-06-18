<script lang="ts">
	import { onDestroy } from 'svelte';

	import Editor from '$lib/components/Editor.svelte';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import { debounce } from '$lib/utils/debounce';
	import { toast } from '$lib/toast';

	interface Props {
		/** Initial notes markdown loaded from storage. */
		notesMarkdown: string;
		editable?: boolean;
		/** Persist the current notes. Markdown is the canonical shape. */
		onSave?: (data: { markdown: string }) => void | Promise<void>;
	}

	let { notesMarkdown, editable = true, onSave }: Props = $props();

	// `savedMarkdown` is the clean baseline; `currentMarkdown` is the editor's live
	// content. Dirtiness is purely `current !== saved`. The editor is only ever
	// seeded from `notesMarkdown` (external), never from its own output, so typing
	// can't trip the reload guard. Mirrors SummaryView, but seeds synchronously
	// from the prop so getMarkdown() is correct before the effect flushes (summary
	// generation may read it immediately after mount).
	// svelte-ignore state_referenced_locally
	let currentMarkdown = $state(notesMarkdown);
	// svelte-ignore state_referenced_locally
	let savedMarkdown = $state(notesMarkdown);
	// svelte-ignore state_referenced_locally
	let lastIncoming = $state(notesMarkdown);

	$effect(() => {
		if (notesMarkdown !== lastIncoming) {
			lastIncoming = notesMarkdown;
			savedMarkdown = notesMarkdown;
			currentMarkdown = notesMarkdown;
		}
	});

	function handleChange(markdown: string): void {
		currentMarkdown = markdown;
		debouncedSave();
	}

	export function getMarkdown(): string {
		return currentMarkdown;
	}

	// Auto-save: debounce edits, guard against overlapping saves, and re-schedule
	// any edit that landed while a save was in flight.
	let saving = false;
	export async function save(): Promise<void> {
		if (!onSave || currentMarkdown === savedMarkdown || saving) return;
		saving = true;
		saveStatus.begin();
		const snapshot = currentMarkdown;
		try {
			await onSave({ markdown: snapshot });
			savedMarkdown = snapshot;
			saveStatus.end(true);
		} catch (e) {
			saveStatus.end(false);
			toast.error('Failed to save notes', { description: String(e) });
		} finally {
			saving = false;
			if (currentMarkdown !== savedMarkdown) debouncedSave();
		}
	}

	const debouncedSave = debounce(() => void save(), 800);
	onDestroy(() => debouncedSave.flush());
</script>

<div class="relative">
	{#if !currentMarkdown.trim()}
		<p
			class="pointer-events-none absolute left-0 top-0 select-none text-base leading-[1.7] text-muted-foreground/40"
		>
			No notes for this meeting yet. Type to add some.
		</p>
	{/if}
	<Editor value={notesMarkdown} {editable} onChange={handleChange} />
</div>
