<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { PanelRightClose, PanelRightOpen } from '@lucide/svelte';

	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import { indexedDBService } from '$lib/services/indexed-db';
	import { config } from '$lib/stores/config.svelte';
	import { notes } from '$lib/stores/notes.svelte';
	import { recordingState, RecordingStatus } from '$lib/stores/recording-state.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { transcripts as transcriptStore } from '$lib/stores/transcript.svelte';

	import { usePermissionCheck } from '$lib/hooks/use-permission-check.svelte';
	import { useRecordingStateSync } from '$lib/hooks/use-recording-state-sync.svelte';
	import { useRecordingStart } from '$lib/hooks/use-recording-start.svelte';
	import { useRecordingStop } from '$lib/hooks/use-recording-stop.svelte';
	import { useTranscriptRecovery } from '$lib/hooks/use-transcript-recovery.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import type { ModalType } from '$lib/hooks/use-modal-state.svelte';

	import Editor from '$lib/components/Editor.svelte';
	import PermissionWarning from '$lib/components/PermissionWarning.svelte';
	import TranscriptPanel from '$lib/components/home/TranscriptPanel.svelte';
	import RecordingControls from '$lib/components/RecordingControls.svelte';
	import StatusOverlays from '$lib/components/StatusOverlays.svelte';
	import TranscriptRecovery from '$lib/components/TranscriptRecovery/TranscriptRecovery.svelte';
	import Tooltip from '$lib/ui/tooltip.svelte';

	const isBrowser = typeof window !== 'undefined';

	let barHeights = $state<string[]>(['58%', '76%', '58%']);
	let showRecoveryDialog = $state(false);

	// Transcript side panel: open by default only on wide windows, matching the
	// saved-meeting view. The notes editor is the primary surface.
	let showTranscript = $state(
		typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches
	);

	// Non-reactive snapshot of the notes so the editor isn't re-seeded on every
	// keystroke (mirrors SummaryView's one-way load). Reads the store on (re)mount
	// so notes survive navigating away and back mid-recording.
	const initialNotes = notes.markdown;

	const permissions = usePermissionCheck();
	const recordingSync = useRecordingStateSync();
	const platform = usePlatform();

	// Settings-type modals (language/model) live on the dedicated /settings route
	// now; only the inline error alert surfaces a toast here.
	function showModal(name: ModalType, message?: string): void {
		if (name === 'errorAlert') {
			if (message) toast.error('Transcription error', { description: message });
			return;
		}
		void goto('/settings');
	}

	// `isRecording` lives in the recordingState store (driven by Tauri events), so
	// the legacy `setIsRecording` callback is a no-op here.
	const noopSetIsRecording = (_value: boolean): void => {};

	const recordingStart = useRecordingStart(noopSetIsRecording, (name, msg) =>
		showModal(name, msg)
	);

	const recordingStop = useRecordingStop(noopSetIsRecording, recordingSync.setIsRecordingDisabled);

	const recovery = useTranscriptRecovery();

	const isProcessingStop = $derived(
		recordingState.status === RecordingStatus.PROCESSING_TRANSCRIPTS || recordingState.isProcessing
	);

	// D4: the in-app pill is the idle/start surface only. Once a recording is active,
	// the floating pill window owns the active controls, so suppress the in-app pill
	// while recording (it reappears for the next idle/start state).
	const showRecordingControls = $derived(
		permissions.hasMicrophone &&
			!recordingState.isRecording &&
			recordingState.status !== RecordingStatus.PROCESSING_TRANSCRIPTS &&
			recordingState.status !== RecordingStatus.SAVING
	);

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
								}
							}
						: undefined,
					duration: 10000
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
				description: error instanceof Error ? error.message : 'Unknown error occurred'
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

	// Show the recovery dialog once per session when meetings appear.
	$effect(() => {
		if (recovery.recoverableMeetings.length > 0 && isBrowser) {
			const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
			if (!shownThisSession) {
				showRecoveryDialog = true;
				sessionStorage.setItem('recovery_dialog_shown', 'true');
			}
		}
	});

	// Animate the recording bars while recording.
	$effect(() => {
		if (!recordingState.isRecording) return;
		const interval = setInterval(() => {
			barHeights = [
				`${Math.random() * 20 + 10}px`,
				`${Math.random() * 20 + 10}px`,
				`${Math.random() * 20 + 10}px`
			];
		}, 300);
		return () => clearInterval(interval);
	});

	onMount(() => {
		void Analytics.trackPageView('home');

		// ⌘T toggles the live transcript panel, matching the saved-meeting view.
		const handleKeydown = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
				e.preventDefault();
				showTranscript = !showTranscript;
			}
		};
		window.addEventListener('keydown', handleKeydown);

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

		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

<div
	class="flex h-screen flex-col bg-background"
	in:fly={{ y: 20, duration: 300 }}
>
	<TranscriptRecovery
		open={showRecoveryDialog}
		onClose={handleDialogClose}
		recoverableMeetings={recovery.recoverableMeetings}
		onRecover={handleRecovery}
		onDelete={recovery.deleteRecoverableMeeting}
		onLoadPreview={recovery.loadMeetingTranscripts}
	/>

	<div class="flex flex-1 overflow-hidden">
		<!-- Primary surface: the notes editor. The live transcript is secondary,
		     in a toggleable side panel (⌘T), mirroring the saved-meeting view. -->
		<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
			<div
				data-tauri-drag-region="deep"
				class="flex flex-shrink-0 items-center justify-end px-8 pb-1 pt-7"
			>
				<Tooltip label={showTranscript ? 'Hide transcript' : 'Show transcript'} shortcut="⌘T">
					{#snippet trigger()}
						<button
							onclick={() => (showTranscript = !showTranscript)}
							class="flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
							aria-label={showTranscript ? 'Hide transcript' : 'Show transcript'}
						>
							{#if showTranscript}
								<PanelRightClose class="size-4" />
							{:else}
								<PanelRightOpen class="size-4" />
							{/if}
						</button>
					{/snippet}
				</Tooltip>
			</div>

			<div class="flex-1 overflow-y-auto">
				<div class="mx-auto w-2/3 max-w-[750px] px-2 pb-40 pt-2">
					{#if !recordingState.isRecording && !permissions.isChecking && !platform.isLinux}
						<div class="mb-6">
							<PermissionWarning
								hasMicrophone={permissions.hasMicrophone}
								hasSystemAudio={permissions.hasSystemAudio}
								onRecheck={permissions.checkPermissions}
								isRechecking={permissions.isChecking}
							/>
						</div>
					{/if}

					<div class="relative">
						{#if !notes.markdown.trim()}
							<p
								class="pointer-events-none absolute left-0 top-0 select-none text-base leading-[1.7] text-muted-foreground/40"
							>
								Take notes…
							</p>
						{/if}
						<Editor value={initialNotes} onChange={(md) => notes.set(md)} />
					</div>
				</div>
			</div>
		</div>

		{#if showTranscript}
			<aside
				class="flex w-2/5 min-w-[340px] max-w-[460px] flex-col overflow-hidden border-l border-border"
			>
				<TranscriptPanel
					{isProcessingStop}
					isStopping={recordingState.isStopping}
					{showModal}
					compact
				/>
			</aside>
		{/if}

		{#if showRecordingControls}
			<div class="fixed bottom-12 left-0 right-0 z-10">
				<div
					class={`flex justify-center ${sidebar.isResizing ? '' : 'transition-[margin] duration-300'}`}
					style={`margin-left: ${sidebar.effectiveWidth}px`}
				>
					<div class="flex w-2/3 max-w-[750px] justify-center">
						<div class="flex items-center">
							<RecordingControls
								isRecording={recordingState.isRecording}
								onRecordingStop={(callApi = true) => void recordingStop.handleRecordingStop(callApi)}
								onRecordingStart={recordingStart.handleRecordingStart}
								onStopInitiated={() => recordingStop.setIsStopping(true)}
								onTranscriptionError={(message) => showModal('errorAlert', message)}
								isRecordingDisabled={recordingSync.isRecordingDisabled}
								isParentProcessing={isProcessingStop}
								barHeights={barHeights}
								selectedDevices={config.selectedDevices}
								meetingName={transcriptStore.meetingTitle}
							/>
						</div>
					</div>
				</div>
			</div>
		{/if}

		<StatusOverlays
			isProcessing={recordingState.status === RecordingStatus.PROCESSING_TRANSCRIPTS &&
				!recordingState.isRecording}
			isSaving={recordingState.status === RecordingStatus.SAVING}
		/>
	</div>
</div>
