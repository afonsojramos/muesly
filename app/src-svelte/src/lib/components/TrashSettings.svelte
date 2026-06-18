<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { RotateCcw, Trash2 } from '@lucide/svelte';

	import { toast } from '$lib/toast';
	import { sidebar } from '$lib/stores/sidebar.svelte';

	interface TrashedMeeting {
		id: string;
		title: string;
		created_at: string;
	}

	let trashed = $state<TrashedMeeting[]>([]);
	let isLoading = $state(true);
	// Permanent delete uses an inline confirm (no modal): first click arms it.
	let confirmingId = $state<string | null>(null);

	async function loadTrash(): Promise<void> {
		isLoading = true;
		try {
			trashed = await invoke<TrashedMeeting[]>('api_get_trashed_meetings');
		} catch (error) {
			console.error('Failed to load trash:', error);
			toast.error('Failed to load trash');
		} finally {
			isLoading = false;
		}
	}

	async function handleRestore(meeting: TrashedMeeting): Promise<void> {
		try {
			await invoke('api_restore_meeting', { meetingId: meeting.id });
			trashed = trashed.filter((m) => m.id !== meeting.id);
			await sidebar.refetchMeetings();
			toast.success('Meeting restored');
		} catch (error) {
			console.error('Failed to restore meeting:', error);
			toast.error('Failed to restore meeting');
		}
	}

	async function handlePermanentDelete(meeting: TrashedMeeting): Promise<void> {
		try {
			await invoke('api_permanently_delete_meeting', { meetingId: meeting.id });
			trashed = trashed.filter((m) => m.id !== meeting.id);
			confirmingId = null;
			toast.success('Meeting permanently deleted');
		} catch (error) {
			console.error('Failed to permanently delete meeting:', error);
			toast.error('Failed to permanently delete meeting');
		}
	}

	function formatDate(iso: string): string {
		const date = new Date(iso);
		if (isNaN(date.getTime())) return '';
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	onMount(loadTrash);
</script>

<div class="space-y-6">
	<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
		<h3 class="mb-2 text-lg font-semibold">Trash</h3>
		<p class="mb-6 text-sm text-muted-foreground">
			Deleted meetings are kept here so you can restore them. Permanently deleting removes the
			meeting, its transcript, and summary for good.
		</p>

		{#if isLoading}
			<p class="text-sm text-muted-foreground">Loading…</p>
		{:else if trashed.length === 0}
			<div class="rounded-lg border border-border bg-secondary/40 p-6 text-center">
				<p class="text-sm text-muted-foreground">Trash is empty</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each trashed as meeting (meeting.id)}
					<div
						class="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3"
					>
						<div class="min-w-0 flex-1">
							<div class="truncate font-medium">{meeting.title}</div>
							<div class="text-xs text-muted-foreground">{formatDate(meeting.created_at)}</div>
						</div>

						<button
							onclick={() => handleRestore(meeting)}
							class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-secondary"
						>
							<RotateCcw class="size-3.5" /> Restore
						</button>

						{#if confirmingId === meeting.id}
							<button
								onclick={() => handlePermanentDelete(meeting)}
								class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground transition-opacity hover:opacity-90"
							>
								<Trash2 class="size-3.5" /> Confirm
							</button>
							<button
								onclick={() => (confirmingId = null)}
								class="flex-shrink-0 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
							>
								Cancel
							</button>
						{:else}
							<button
								onclick={() => (confirmingId = meeting.id)}
								class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
							>
								<Trash2 class="size-3.5" /> Delete forever
							</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
