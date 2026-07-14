<script lang="ts">
	import { FileText, Folder, LoaderCircle } from '@lucide/svelte';

	import { navigate } from '$lib/navigation';
	import { compareByDateDesc } from '$lib/date-groups';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import * as Command from '$lib/components/ui/command';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let query = $state('');
	let debounce: ReturnType<typeof setTimeout> | undefined;

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const meetings = [...sidebar.meetings].sort((a, b) =>
			compareByDateDesc(a.createdAt, b.createdAt),
		);
		if (!q) return meetings.slice(0, 8);

		const transcriptMatches = new Set(sidebar.searchResults.map((result) => result.id));
		return meetings
			.filter(
				(meeting) => transcriptMatches.has(meeting.id) || meeting.title.toLowerCase().includes(q),
			)
			.slice(0, 12);
	});

	function onInput(value: string): void {
		query = value;
		clearTimeout(debounce);
		debounce = setTimeout(() => void sidebar.searchTranscripts(value.trim()), 150);
	}

	function folderName(folderId?: string): string | null {
		if (!folderId) return null;
		return sidebar.folders.find((folder) => folder.id === folderId)?.name ?? null;
	}

	function snippet(meetingId: string): string | null {
		return sidebar.searchResults.find((result) => result.id === meetingId)?.matchContext ?? null;
	}

	function openMeeting(meetingId: string): void {
		open = false;
		query = '';
		void navigate(`/meeting-details?id=${meetingId}`);
	}

	function handleOpenChange(nextOpen: boolean): void {
		open = nextOpen;
		if (nextOpen) return;
		clearTimeout(debounce);
		query = '';
		void sidebar.searchTranscripts('');
	}
</script>

<Command.Dialog
	{open}
	onOpenChange={handleOpenChange}
	shouldFilter={false}
	loop
	title="Search notes"
	description="Search meeting titles and transcripts"
	class="top-[18%] max-w-xl translate-y-0"
>
	<Command.Input
		value={query}
		oninput={(event) => onInput(event.currentTarget.value)}
		placeholder="Search notes and transcripts…"
		aria-label="Search notes and transcripts"
	/>
	<Command.List class="max-h-[min(28rem,60vh)]">
		{#if sidebar.isSearching && query.trim()}
			<div class="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
				<LoaderCircle class="size-3.5 animate-spin" />
				Searching transcripts…
			</div>
		{/if}

		{#if results.length === 0 && query.trim()}
			<Command.Empty>No notes match “{query.trim()}”.</Command.Empty>
		{:else}
			<Command.Group heading={query.trim() ? 'Results' : 'Recent notes'}>
				{#each results as meeting (meeting.id)}
					{@const meetingFolder = folderName(meeting.folderId)}
					{@const context = snippet(meeting.id)}
					<Command.Item
						value={`${meeting.id} ${meeting.title}`}
						class="min-h-12 items-start py-2"
						onSelect={() => openMeeting(meeting.id)}
					>
						<FileText class="mt-0.5 size-4 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="truncate font-medium">{meeting.title}</span>
								{#if meetingFolder}
									<span
										class="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
									>
										<Folder class="size-3" />
										{meetingFolder}
									</span>
								{/if}
							</div>
							{#if context}
								<p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{context}</p>
							{/if}
						</div>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
