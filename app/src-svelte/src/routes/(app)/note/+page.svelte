<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { navigate } from '$lib/navigation';

	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import { notes } from '$lib/stores/notes.svelte';
	import { recordingState, RecordingStatus } from '$lib/stores/recording-state.svelte';
	import { liveTranscriptPanel } from '$lib/stores/live-transcript-panel.svelte';

	import { usePermissionCheck } from '$lib/hooks/use-permission-check.svelte';
	import { useRecordingStart } from '$lib/hooks/use-recording-start.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import type { ModalType } from '$lib/hooks/use-modal-state.svelte';

	import Editor from '$lib/components/Editor.svelte';
	import PermissionWarning from '$lib/components/PermissionWarning.svelte';
	import TranscriptPanel from '$lib/components/home/TranscriptPanel.svelte';
	import StatusOverlays from '$lib/components/StatusOverlays.svelte';

	// Non-reactive snapshot of the notes so the editor isn't re-seeded on every
	// keystroke. Reads the store on (re)mount so notes survive navigating away and
	// back mid-recording.
	const initialNotes = notes.markdown;

	const permissions = usePermissionCheck();
	const platform = usePlatform();

	// Settings-type modals (language/model) live on the dedicated /settings route
	// now; only the inline error alert surfaces a toast here.
	function showModal(name: ModalType, message?: string): void {
		if (name === 'errorAlert') {
			if (message) toast.error('Transcription error', { description: message });
			return;
		}
		void navigate('/settings');
	}

	// `isRecording` lives in the recordingState store (driven by Tauri events), so
	// the legacy `setIsRecording` callback is a no-op here.
	const noopSetIsRecording = (_value: boolean): void => {};

	// Recording is controlled from the sidebar, tray, and floating pill. This hook
	// stays mounted for its side effect: its onMount auto-starts a recording when
	// the `autoStartRecording` flag is set and navigation lands here.
	useRecordingStart(noopSetIsRecording, (name, msg) => showModal(name, msg));

	const isProcessingStop = $derived(
		recordingState.status === RecordingStatus.PROCESSING_TRANSCRIPTS || recordingState.isProcessing,
	);

	onMount(() => {
		void Analytics.trackPageView('note');

		// ⌘T toggles the live transcript panel, matching the saved-meeting view.
		const handleKeydown = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
				e.preventDefault();
				liveTranscriptPanel.toggle();
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

<div class="flex h-screen flex-col bg-background" in:fly={{ y: 20, duration: 300 }}>
	<div class="flex flex-1 overflow-hidden">
		<!-- Primary surface: the notes editor. The live transcript is secondary,
		     in a toggleable side panel (⌘T), mirroring the saved-meeting view. -->
		<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
			<div class="flex-1 overflow-y-auto">
				<div class="mx-auto w-2/3 max-w-[750px] px-2 pb-40 pt-9">
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
								class="pointer-events-none absolute left-0 top-0 select-none text-base leading-[1.5] text-muted-foreground/40"
							>
								Take notes…
							</p>
						{/if}
						<Editor value={initialNotes} onChange={(md) => notes.set(md)} />
					</div>
				</div>
			</div>
		</div>

		{#if liveTranscriptPanel.open}
			<aside
				class="flex w-2/5 min-w-[340px] max-w-[460px] flex-col overflow-hidden border-l border-border"
			>
				<TranscriptPanel {isProcessingStop} isStopping={recordingState.isStopping} compact />
			</aside>
		{/if}

		<StatusOverlays
			isProcessing={recordingState.status === RecordingStatus.PROCESSING_TRANSCRIPTS &&
				!recordingState.isRecording}
			isSaving={recordingState.status === RecordingStatus.SAVING}
		/>
	</div>
</div>
