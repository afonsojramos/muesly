<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { onDestroy } from 'svelte';

	import type { Summary, SummaryDataResponse } from '$lib/types';
	import { summaryToMarkdown } from '$lib/utils/summary-markdown';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import { debounce } from '$lib/utils/debounce';
	import { toast } from '$lib/toast';
	import * as Alert from '$lib/components/ui/alert';
	import Editor from './Editor.svelte';

	type SummaryStatus =
		| 'idle'
		| 'processing'
		| 'summarizing'
		| 'regenerating'
		| 'completed'
		| 'error';

	interface Props {
		summaryData: SummaryDataResponse | Summary | null;
		status?: SummaryStatus;
		error?: string | null;
		editable?: boolean;
		/** Markdown is the canonical persisted shape; we only ever emit markdown. */
		onSave?: (data: { markdown: string }) => void | Promise<void>;
	}

	let { summaryData, status = 'idle', error = null, editable = true, onSave }: Props = $props();

	const incomingMarkdown = $derived(summaryToMarkdown(summaryData));
	// `savedMarkdown` is the single clean baseline; `currentMarkdown` is the
	// editor's live content. Dirtiness is purely `current !== saved`.
	let currentMarkdown = $state('');
	let savedMarkdown = $state('');
	let lastIncoming = $state('');

	// External change (initial load / regenerate): reset both the working copy
	// and the clean baseline. Note: an in-progress edit is intentionally
	// replaced — regenerate is an explicit user action that supersedes edits.
	$effect(() => {
		if (incomingMarkdown !== lastIncoming) {
			lastIncoming = incomingMarkdown;
			savedMarkdown = incomingMarkdown;
			currentMarkdown = incomingMarkdown;
		}
	});

	function handleChange(markdown: string): void {
		currentMarkdown = markdown;
		debouncedSave();
	}

	const isLoading = $derived(
		status === 'processing' || status === 'summarizing' || status === 'regenerating'
	);
	const hasContent = $derived(incomingMarkdown.trim().length > 0);

	export function getMarkdown(): string {
		return currentMarkdown;
	}

	// Auto-save: debounce edits, guard against overlapping/mid-generation saves,
	// and re-schedule any edit that landed while a save was in flight.
	let saving = false;
	export async function save(): Promise<void> {
		if (!onSave || currentMarkdown === savedMarkdown || saving) return;
		// Don't persist while a generation is streaming content in.
		if (status === 'processing' || status === 'summarizing' || status === 'regenerating') return;
		saving = true;
		saveStatus.begin();
		const snapshot = currentMarkdown;
		try {
			await onSave({ markdown: snapshot });
			savedMarkdown = snapshot;
			saveStatus.end(true);
		} catch (e) {
			saveStatus.end(false);
			toast.error('Failed to save summary', { description: String(e) });
		} finally {
			saving = false;
			if (currentMarkdown !== savedMarkdown) debouncedSave();
		}
	}

	const debouncedSave = debounce(() => void save(), 800);
	onDestroy(() => debouncedSave.flush());
</script>

{#if error}
	<Alert.Root variant="destructive">
		<CircleAlertIcon />
		<Alert.Title>Error Generating Summary</Alert.Title>
		<Alert.Description>
			<p>{error}</p>
			<p class="text-muted-foreground">
				Please check your model configuration and API keys, or try again.
			</p>
		</Alert.Description>
	</Alert.Root>
{:else if isLoading}
	<Alert.Root class="text-accent">
		<Loader2Icon class="animate-spin" />
		<Alert.Title>
			{status === 'processing' ? 'Processing Transcript' : 'Generating Summary'}
		</Alert.Title>
		<Alert.Description>
			{status === 'processing'
				? 'Analyzing your transcript…'
				: 'Creating a detailed summary of your meeting…'}
		</Alert.Description>
	</Alert.Root>
{:else if !hasContent && status === 'completed'}
	<Alert.Root class="text-center">
		<Alert.Title>No summary content available.</Alert.Title>
		<Alert.Description>Try generating a new summary.</Alert.Description>
	</Alert.Root>
{:else}
	<Editor value={incomingMarkdown} {editable} onChange={handleChange} />
{/if}
