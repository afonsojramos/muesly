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
	let loadError = $state(false);
	let pendingId = $state<string | null>(null);
	let pendingAction = $state<'restore' | 'delete' | null>(null);
	// Permanent delete uses an inline confirm (no modal): first click arms it.
	let confirmingId = $state<string | null>(null);

	async function loadTrash(): Promise<void> {
		isLoading = true;
		loadError = false;
		try {
			trashed = await invoke<TrashedMeeting[]>('api_get_trashed_meetings');
		} catch (error) {
			loadError = true;
			console.error('Failed to load trash:', error);
			toast.error('Failed to load trash');
		} finally {
			isLoading = false;
		}
	}

	async function handleRestore(meeting: TrashedMeeting): Promise<void> {
		pendingId = meeting.id;
		pendingAction = 'restore';
		try {
			await invoke('api_restore_meeting', { meetingId: meeting.id });
			trashed = trashed.filter((m) => m.id !== meeting.id);
			await sidebar.refetchMeetings();
		} catch (error) {
			console.error('Failed to restore meeting:', error);
			toast.error('Failed to restore meeting');
		} finally {
			pendingId = null;
			pendingAction = null;
		}
	}

	async function handlePermanentDelete(meeting: TrashedMeeting): Promise<void> {
		pendingId = meeting.id;
		pendingAction = 'delete';
		try {
			await invoke('api_permanently_delete_meeting', { meetingId: meeting.id });
			trashed = trashed.filter((m) => m.id !== meeting.id);
			confirmingId = null;
		} catch (error) {
			console.error('Failed to permanently delete meeting:', error);
			toast.error('Failed to permanently delete meeting');
		} finally {
			pendingId = null;
			pendingAction = null;
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
			<Card.Description>
				Deleted meetings are kept here so you can restore them. Permanently deleting removes the
				meeting, its transcript, and summary for good.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if isLoading}
				<p class="text-sm text-muted-foreground">Loading…</p>
			{:else if loadError}
				<div class="flex flex-col items-start gap-3 rounded-lg bg-destructive/5 p-4">
					<div>
						<p class="font-medium text-destructive">Trash could not be loaded</p>
						<p class="text-sm text-muted-foreground">
							Your deleted meetings have not been changed.
						</p>
					</div>
					<Button variant="outline" size="sm" onclick={loadTrash}>Try again</Button>
				</div>
			{:else if trashed.length === 0}
				<div class="rounded-lg border border-border bg-secondary/40 p-6 text-center">
					<p class="text-sm text-muted-foreground">Trash is empty</p>
				</div>
			{:else}
				<div class="flex flex-col gap-2">
					{#each trashed as meeting (meeting.id)}
						<div
							class="flex flex-col gap-3 rounded-lg bg-muted/35 px-4 py-3 sm:flex-row sm:items-center"
						>
							<div class="min-w-0 flex-1">
								<div class="truncate font-medium">{meeting.title}</div>
								<div class="text-xs text-muted-foreground">{formatDate(meeting.created_at)}</div>
							</div>

							<Button
								variant="outline"
								size="sm"
								class="flex-shrink-0"
								disabled={pendingId === meeting.id}
								onclick={() => handleRestore(meeting)}
							>
								<RotateCcw data-icon="inline-start" />
								{pendingId === meeting.id && pendingAction === 'restore' ? 'Restoring…' : 'Restore'}
							</Button>

							{#if confirmingId === meeting.id}
								<Button
									variant="destructive"
									size="sm"
									class="flex-shrink-0"
									disabled={pendingId === meeting.id}
									onclick={() => handlePermanentDelete(meeting)}
								>
									<Trash2 data-icon="inline-start" />
									{pendingId === meeting.id && pendingAction === 'delete'
										? 'Deleting…'
										: 'Confirm delete'}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									class="flex-shrink-0"
									disabled={pendingId === meeting.id}
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
