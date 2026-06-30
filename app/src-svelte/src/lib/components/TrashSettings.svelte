<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { RotateCcw, Trash2 } from '@lucide/svelte';

	import { toast } from '$lib/toast';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';

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

<div class="flex flex-col gap-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>Trash</Card.Title>
			<Card.Description>
				Deleted meetings are kept here so you can restore them. Permanently deleting removes the
				meeting, its transcript, and summary for good.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if isLoading}
				<p class="text-sm text-muted-foreground">Loading…</p>
			{:else if trashed.length === 0}
				<div class="rounded-lg border border-border bg-secondary/40 p-6 text-center">
					<p class="text-sm text-muted-foreground">Trash is empty</p>
				</div>
			{:else}
				<div class="flex flex-col gap-2">
					{#each trashed as meeting (meeting.id)}
						<div
							class="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3"
						>
							<div class="min-w-0 flex-1">
								<div class="truncate font-medium">{meeting.title}</div>
								<div class="text-xs text-muted-foreground">{formatDate(meeting.created_at)}</div>
							</div>

							<Button
								variant="outline"
								size="sm"
								class="flex-shrink-0"
								onclick={() => handleRestore(meeting)}
							>
								<RotateCcw data-icon="inline-start" /> Restore
							</Button>

							{#if confirmingId === meeting.id}
								<Button
									variant="destructive"
									size="sm"
									class="flex-shrink-0"
									onclick={() => handlePermanentDelete(meeting)}
								>
									<Trash2 data-icon="inline-start" /> Confirm
								</Button>
								<Button
									variant="ghost"
									size="sm"
									class="flex-shrink-0"
									onclick={() => (confirmingId = null)}
								>
									Cancel
								</Button>
							{:else}
								<Button
									variant="destructive"
									size="sm"
									class="flex-shrink-0"
									onclick={() => (confirmingId = meeting.id)}
								>
									<Trash2 data-icon="inline-start" /> Delete forever
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
