<script lang="ts" module>
	// Lightweight relative-time formatter (replaces date-fns formatDistanceToNow).
	export function formatRelativeTime(timestamp: number): string {
		const diffMs = Date.now() - timestamp;
		const seconds = Math.round(diffMs / 1000);
		if (seconds < 60) return seconds <= 5 ? 'just now' : `${seconds} seconds ago`;
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
		const days = Math.round(hours / 24);
		return `${days} day${days === 1 ? '' : 's'} ago`;
	}
</script>

<script lang="ts">
	import {
		AlertCircle,
		CheckCircle2,
		Clock,
		FileText,
		Loader2,
		Trash2,
		XCircle,
	} from '@lucide/svelte';

	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Alert from '$lib/components/ui/alert';
	import { cn } from '$lib/utils';
	import type { MeetingMetadata, StoredTranscript } from '$lib/services/indexed-db';

	interface Props {
		open: boolean;
		onClose: () => void;
		recoverableMeetings: MeetingMetadata[];
		onRecover: (meetingId: string) => Promise<unknown>;
		onDelete: (meetingId: string) => Promise<void>;
		onLoadPreview: (meetingId: string) => Promise<StoredTranscript[]>;
	}

	let { open, onClose, recoverableMeetings, onRecover, onDelete, onLoadPreview }: Props = $props();

	let selectedMeetingId = $state<string | null>(null);
	let previewTranscripts = $state<StoredTranscript[]>([]);
	let isLoadingPreview = $state(false);
	let isRecovering = $state(false);
	let isDeleting = $state(false);

	const selectedMeeting = $derived(
		recoverableMeetings.find((m) => m.meetingId === selectedMeetingId) ?? null,
	);

	async function handleMeetingSelect(meetingId: string): Promise<void> {
		selectedMeetingId = meetingId;
		isLoadingPreview = true;
		try {
			const stored = await onLoadPreview(meetingId);
			previewTranscripts = stored.slice(0, 10);
		} catch (error) {
			console.error('Failed to load preview:', error);
			previewTranscripts = [];
		} finally {
			isLoadingPreview = false;
		}
	}

	// Reset selection when the dialog opens; auto-select the first meeting.
	$effect(() => {
		if (open) {
			if (recoverableMeetings.length > 0 && !selectedMeetingId) {
				const first = recoverableMeetings[0];
				if (first) void handleMeetingSelect(first.meetingId);
			}
		} else {
			selectedMeetingId = null;
			previewTranscripts = [];
		}
	});

	async function handleRecover(): Promise<void> {
		if (!selectedMeetingId) return;
		isRecovering = true;
		try {
			await onRecover(selectedMeetingId);
			onClose();
		} catch (error) {
			console.error('Recovery failed:', error);
		} finally {
			isRecovering = false;
		}
	}

	async function handleDelete(): Promise<void> {
		if (!selectedMeetingId) return;
		if (
			typeof window !== 'undefined' &&
			!window.confirm('Are you sure you want to delete this meeting? This cannot be undone.')
		) {
			return;
		}
		isDeleting = true;
		try {
			await onDelete(selectedMeetingId);
			selectedMeetingId = null;
			previewTranscripts = [];
		} catch (error) {
			console.error('Delete failed:', error);
		} finally {
			isDeleting = false;
		}
	}

	function previewTimestamp(transcript: StoredTranscript): string {
		if (!transcript.timestamp) return '--:--';
		try {
			const date = new Date(transcript.timestamp);
			if (Number.isNaN(date.getTime())) {
				if (transcript.audio_start_time !== undefined) {
					const totalSecs = Math.floor(transcript.audio_start_time);
					const mins = Math.floor(totalSecs / 60);
					const secs = totalSecs % 60;
					return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
				}
				return '--:--';
			}
			return date.toLocaleTimeString();
		} catch {
			return '--:--';
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(next) => {
		if (!next) onClose();
	}}
>
	<Dialog.Content class="flex h-[80vh] flex-col sm:max-w-4xl">
		<Dialog.Header>
			<Dialog.Title>Recover Interrupted Meetings</Dialog.Title>
			<Dialog.Description>
				We found {recoverableMeetings.length} meeting{recoverableMeetings.length !== 1 ? 's' : ''} that
				{recoverableMeetings.length !== 1 ? 'were' : 'was'} interrupted. Select a meeting to preview and
				recover it.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex min-h-0 flex-1 gap-4 overflow-hidden">
			<div class="flex w-1/3 flex-col">
				<h3 class="mb-2 text-sm font-medium">Interrupted Meetings</h3>
				<ScrollArea class="flex-1 rounded-lg border border-border">
					<div class="flex flex-col gap-2 p-2">
						{#each recoverableMeetings as meeting (meeting.meetingId)}
							<button
								onclick={() => handleMeetingSelect(meeting.meetingId)}
								class={cn(
									'w-full rounded-lg border p-3 text-left transition-colors',
									selectedMeetingId === meeting.meetingId
										? 'border-primary bg-primary/10'
										: 'border-transparent hover:bg-secondary',
								)}
							>
								<div class="flex items-start justify-between gap-2">
									<div class="min-w-0 flex-1">
										<p class="truncate text-sm font-medium">{meeting.title}</p>
										<p class="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
											<Clock class="size-3" />
											{formatRelativeTime(meeting.lastUpdated)}
										</p>
										<p class="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
											<FileText class="size-3" />
											{meeting.transcriptCount} transcript{meeting.transcriptCount !== 1 ? 's' : ''}
										</p>
									</div>
									{#if meeting.folderPath}
										<span title="Audio available">
											<CheckCircle2 class="size-4 shrink-0 text-success" />
										</span>
									{:else}
										<span title="No audio">
											<AlertCircle class="size-4 shrink-0 text-warning" />
										</span>
									{/if}
								</div>
							</button>
						{/each}
					</div>
				</ScrollArea>
			</div>

			<div class="flex flex-1 flex-col">
				<h3 class="mb-2 text-sm font-medium">Preview</h3>
				<div class="flex flex-1 flex-col overflow-hidden rounded-lg border border-border">
					{#if selectedMeeting}
						<div class="border-b border-border bg-secondary/50 p-4">
							<h4 class="font-semibold">{selectedMeeting.title}</h4>
							<p class="mt-1 text-sm text-muted-foreground">
								Started {new Date(selectedMeeting.startTime).toLocaleString()}
							</p>
							<div class="mt-2 flex items-center gap-4 text-sm">
								<span class="flex items-center gap-1">
									<FileText class="size-4" />
									{selectedMeeting.transcriptCount} transcripts
								</span>
								{#if selectedMeeting.folderPath}
									<span class="flex items-center gap-1 text-success">
										<CheckCircle2 class="size-4" />
										Audio available
									</span>
								{:else}
									<span class="flex items-center gap-1 text-warning">
										<AlertCircle class="size-4" />
										No audio
									</span>
								{/if}
							</div>
						</div>

						<ScrollArea class="flex-1">
							<div class="p-4">
								{#if isLoadingPreview}
									<div class="flex h-full items-center justify-center text-muted-foreground">
										Loading preview...
									</div>
								{:else if previewTranscripts.length > 0}
									<div class="flex flex-col gap-3">
										<Alert.Root>
											<Alert.Description>
												Showing first {previewTranscripts.length} transcript segments (of {selectedMeeting.transcriptCount}
												total)
											</Alert.Description>
										</Alert.Root>
										{#each previewTranscripts as transcript, index (transcript.id ?? index)}
											<div class="text-sm">
												<span class="text-muted-foreground">[{previewTimestamp(transcript)}]</span>
												<span>{transcript.text}</span>
											</div>
										{/each}
										{#if selectedMeeting.transcriptCount > 10}
											<p class="text-sm italic text-muted-foreground">
												... and {selectedMeeting.transcriptCount - 10} more transcript{selectedMeeting.transcriptCount -
													10 !==
												1
													? 's'
													: ''}
											</p>
										{/if}
									</div>
								{:else}
									<div class="flex h-full items-center justify-center text-muted-foreground">
										No transcripts to preview
									</div>
								{/if}
							</div>
						</ScrollArea>
					{:else}
						<div class="flex h-full items-center justify-center text-muted-foreground">
							Select a meeting to preview
						</div>
					{/if}
				</div>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose} disabled={isRecovering || isDeleting}
				>Cancel</Button
			>
			<Button
				variant="destructive"
				onclick={handleDelete}
				disabled={!selectedMeetingId || isRecovering || isDeleting}
			>
				{#if isDeleting}
					<Loader2 data-icon="inline-start" class="animate-spin" />
					Deleting...
				{:else}
					<Trash2 data-icon="inline-start" />
					Delete
				{/if}
			</Button>
			<Button onclick={handleRecover} disabled={!selectedMeetingId || isRecovering || isDeleting}>
				{#if isRecovering}
					<Loader2 data-icon="inline-start" class="animate-spin" />
					Recovering...
				{:else}
					<CheckCircle2 data-icon="inline-start" />
					Recover
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
