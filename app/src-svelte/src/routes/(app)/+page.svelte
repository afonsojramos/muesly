<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { navigate } from '$lib/navigation';
	import FolderIcon from '@lucide/svelte/icons/folder';

	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import { indexedDBService } from '$lib/services/indexed-db';
	import { recordingState, RecordingStatus } from '$lib/stores/recording-state.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { groupByRecency } from '$lib/date-groups';
	import { formatEventTime } from '$lib/coming-up';

	import { useTranscriptRecovery } from '$lib/hooks/use-transcript-recovery.svelte';

	import ComingUp from '$lib/components/home/ComingUp.svelte';
	import TranscriptRecovery from '$lib/components/TranscriptRecovery/TranscriptRecovery.svelte';

	const isBrowser = typeof window !== 'undefined';

	let showRecoveryDialog = $state(false);
	const recovery = useTranscriptRecovery();

	// Recent notes, newest-first, grouped into recency buckets ("This Week", month
	// names, …). This is the home overview that replaced the note editor.
	const noteGroups = $derived(groupByRecency(sidebar.meetings, (m) => m.createdAt));

	// Folder lookup for the per-note folder chip.
	const folderById = $derived(new Map(sidebar.folders.map((f) => [f.id, f])));

	function openMeeting(id: string): void {
		void goto(`/meeting-details?id=${id}`);
	}

	async function handleRecovery(meetingId: string): Promise<void> {
		try {
			const result = await recovery.recoverMeeting(meetingId);
			if (result.success) {
				toast.success('Meeting recovered successfully!', {
					description:
						result.audioRecoveryStatus?.status === 'success'
							? 'Transcripts and audio recovered'
							: 'Transcripts recovered (no audio available)',
					action: result.meetingId
						? {
								label: 'View Meeting',
								onClick: () => {
									void goto(`/meeting-details?id=${result.meetingId}`);
								},
							}
						: undefined,
					duration: 10000,
				});

				await sidebar.refetchMeetings();

				if (recovery.recoverableMeetings.length === 0 && isBrowser) {
					sessionStorage.removeItem('recovery_dialog_shown');
				}

				if (result.meetingId) {
					const id = result.meetingId;
					setTimeout(() => {
						void goto(`/meeting-details?id=${id}`);
					}, 2000);
				}
			}
		} catch (error) {
			toast.error('Failed to recover meeting', {
				description: error instanceof Error ? error.message : 'Unknown error occurred',
			});
			throw error;
		}
	}

	function handleDialogClose(): void {
		showRecoveryDialog = false;
		if (recovery.recoverableMeetings.length === 0 && isBrowser) {
			sessionStorage.removeItem('recovery_dialog_shown');
		}
	}

	// Show the recovery dialog once per session when recoverable meetings appear.
	$effect(() => {
		if (recovery.recoverableMeetings.length > 0 && isBrowser) {
			const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
			if (!shownThisSession) {
				showRecoveryDialog = true;
				sessionStorage.setItem('recovery_dialog_shown', 'true');
			}
		}
	});

	onMount(() => {
		void Analytics.trackPageView('home');

		const performStartupChecks = async (): Promise<void> => {
			try {
				if (
					recordingState.isRecording ||
					recordingState.status === RecordingStatus.STOPPING ||
					recordingState.status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
					recordingState.status === RecordingStatus.SAVING
				) {
					return;
				}

				try {
					await indexedDBService.deleteOldMeetings(7);
				} catch (error) {
					console.warn('Failed to clean up old meetings:', error);
				}

				try {
					await indexedDBService.deleteSavedMeetings(24);
				} catch (error) {
					console.warn('Failed to clean up saved meetings:', error);
				}

				await recovery.checkForRecoverableTranscripts();
			} catch (error) {
				console.error('Failed to perform startup checks:', error);
			}
		};

		void performStartupChecks();
	});
</script>

<div class="flex h-screen flex-col overflow-hidden bg-background" in:fly={{ y: 20, duration: 300 }}>
	<TranscriptRecovery
		open={showRecoveryDialog}
		onClose={handleDialogClose}
		recoverableMeetings={recovery.recoverableMeetings}
		onRecover={handleRecovery}
		onDelete={recovery.deleteRecoverableMeeting}
		onLoadPreview={recovery.loadMeetingTranscripts}
	/>

	<!-- Draggable strip that clears the macOS traffic lights. -->
	<div data-tauri-drag-region="deep" class="h-8 flex-shrink-0"></div>

	<div class="flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-[820px] px-8 pb-24 pt-4">
			<ComingUp />

			{#each noteGroups as group (group.label)}
				<section class="mb-8">
					<h2 class="mb-1 px-3 text-xs font-medium text-muted-foreground/70">{group.label}</h2>
					<div class="flex flex-col">
						{#each group.items as meeting (meeting.id)}
							{@const folder = meeting.folderId ? folderById.get(meeting.folderId) : undefined}
							<!-- The title button stretches over the whole row (after:inset-0), so the
							     folder chip stays a valid sibling link instead of a nested button. -->
							<div
								class="relative flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-secondary"
							>
								<button
									type="button"
									onclick={() => openMeeting(meeting.id)}
									class="min-w-0 flex-1 truncate text-left text-sm font-medium after:absolute after:inset-0 after:rounded-lg"
								>
									{meeting.title}
								</button>
								{#if folder}
									<button
										type="button"
										onclick={() => void navigate(`/folder?id=${folder.id}`)}
										aria-label={`Open folder ${folder.name}`}
										class="relative z-10 inline-flex max-w-40 flex-shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
									>
										{#if folder.emoji}
											<span aria-hidden="true">{folder.emoji}</span>
										{:else}
											<FolderIcon class="size-3" />
										{/if}
										<span class="truncate">{folder.name}</span>
									</button>
								{/if}
								<span class="flex-shrink-0 text-xs text-muted-foreground">
									{formatEventTime(meeting.createdAt ?? '')}
								</span>
							</div>
						{/each}
					</div>
				</section>
			{/each}

			{#if noteGroups.length === 0 && sidebar.meetingsLoaded}
				<div class="py-20 text-center text-sm text-muted-foreground">
					No notes yet. Start a recording to create one.
				</div>
			{/if}
		</div>
	</div>
</div>
