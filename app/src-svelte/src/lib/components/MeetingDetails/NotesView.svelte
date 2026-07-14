<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	import Editor from '$lib/components/Editor.svelte';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import { debounce } from '$lib/utils/debounce';
	import { toast } from '$lib/toast';
	import {
		NOTES_INSERTION_EVENT,
		persistMarkdownInsertion,
		type NotesInsertionRequest,
	} from '$lib/notes/insertion';

	interface Props {
		/** Initial notes markdown loaded from storage. */
		notesMarkdown: string;
		meetingId?: string;
		editable?: boolean;
		/** Persist the current notes. Markdown is the canonical shape. */
		onSave?: (data: { markdown: string }) => void | Promise<void>;
	}

	let { notesMarkdown, meetingId, editable = true, onSave }: Props = $props();
	let notesEditor = $state<ReturnType<typeof Editor>>();

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
	let activeSave: Promise<boolean> | null = null;
	async function persistCurrent(showError = true): Promise<boolean> {
		if (!onSave || currentMarkdown === savedMarkdown) return true;
		if (activeSave) {
			await activeSave;
			if (!onSave || currentMarkdown === savedMarkdown) return true;
		}
		const snapshot = currentMarkdown;
		saveStatus.begin();
		activeSave = (async () => {
			try {
				await onSave({ markdown: snapshot });
				savedMarkdown = snapshot;
				saveStatus.end(true);
				return true;
			} catch (e) {
				saveStatus.end(false);
				if (showError) toast.error('Failed to save notes', { description: String(e) });
				return false;
			} finally {
				activeSave = null;
			}
		})();
		const succeeded = await activeSave;
		if (currentMarkdown !== savedMarkdown) debouncedSave();
		return succeeded;
	}

	export async function save(): Promise<void> {
		await persistCurrent();
	}

	const debouncedSave = debounce(() => void save(), 800);

	async function insertResponse(markdown: string): Promise<void> {
		if (activeSave) await activeSave;
		if (currentMarkdown !== savedMarkdown && !(await persistCurrent(false))) {
			throw new Error('Save the current notes before inserting a response.');
		}
		const outcome = await persistMarkdownInsertion({
			addition: markdown,
			read: () => currentMarkdown,
			write: (value) => {
				currentMarkdown = value;
				notesEditor?.setMarkdown(value);
			},
			save: async () => {
				if (!(await persistCurrent(false)))
					throw new Error('The response was not saved. Try again.');
			},
		});
		notesEditor?.focus();
		if (outcome === 'retained-after-concurrent-edit') {
			toast.error('Failed to save notes', {
				description: 'Your latest edit is still here. Saving will retry automatically.',
			});
			debouncedSave();
		}
	}

	onMount(() => {
		const handleNotesInsertion = (event: Event): void => {
			const detail = (event as CustomEvent<NotesInsertionRequest>).detail;
			if (detail.handled || !meetingId || !onSave || detail.meetingId !== meetingId) return;
			detail.handled = true;
			void insertResponse(detail.markdown).then(
				() => detail.complete(),
				(error) => detail.complete(error),
			);
		};
		window.addEventListener(NOTES_INSERTION_EVENT, handleNotesInsertion);
		return () => window.removeEventListener(NOTES_INSERTION_EVENT, handleNotesInsertion);
	});
	onDestroy(() => debouncedSave.flush());
</script>

<div class="relative">
	{#if !currentMarkdown.trim()}
		<p
			class="pointer-events-none absolute left-0 top-0 select-none text-base leading-[1.5] text-muted-foreground/40"
		>
			No notes for this meeting yet. Type to add some.
		</p>
	{/if}
	<Editor bind:this={notesEditor} value={notesMarkdown} {editable} onChange={handleChange} />
</div>
