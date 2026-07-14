<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { navigate } from '$lib/navigation';

	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import { notes } from '$lib/stores/notes.svelte';
	import { recordingState, RecordingStatus } from '$lib/stores/recording-state.svelte';
	import { liveTranscriptPanel } from '$lib/stores/live-transcript-panel.svelte';
	import { transcripts } from '$lib/stores/transcript.svelte';

	import { usePermissionCheck } from '$lib/hooks/use-permission-check.svelte';
	import {
		CALENDAR_DRAFT_PARTICIPANTS_KEY,
		CALENDAR_DRAFT_TITLE_KEY,
		useRecordingStart,
	} from '$lib/hooks/use-recording-start.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import type { ModalType } from '$lib/hooks/use-modal-state.svelte';

	import Editor from '$lib/components/Editor.svelte';
	import PermissionWarning from '$lib/components/PermissionWarning.svelte';
	import StatusOverlays from '$lib/components/StatusOverlays.svelte';
	import { Button } from '$lib/components/ui/button';
	import UsersIcon from '@lucide/svelte/icons/users';

	// Non-reactive snapshot of the notes so the editor isn't re-seeded on every
	// keystroke. Reads the store on (re)mount so notes survive navigating away and
	// back mid-recording.
	const initialNotes = notes.markdown;
	let editor = $state<Editor>();
	const calendarTitle =
		typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(CALENDAR_DRAFT_TITLE_KEY) : null;
	const participantNames: string[] = (() => {
		if (typeof sessionStorage === 'undefined') return [];
		try {
			const value: unknown = JSON.parse(
				sessionStorage.getItem(CALENDAR_DRAFT_PARTICIPANTS_KEY) ?? '[]',
			);
			return Array.isArray(value)
				? value.filter((name): name is string => typeof name === 'string')
				: [];
		} catch {
			return [];
		}
	})();
	const meetingTitle = $derived(calendarTitle ?? transcripts.meetingTitle);

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
		<!-- Primary surface: the notes editor. The live transcript is available
		     from the chat bar's transcript drop-up (⌘T). -->
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

					{#if calendarTitle}
						<header class="mb-7">
							<p class="mb-1 text-xs font-medium text-muted-foreground">Meeting notes</p>
							<h1 class="text-balance font-display text-2xl font-semibold tracking-tight">
								{meetingTitle}
							</h1>
							{#if participantNames.length > 0}
								<div class="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Tag participants">
									<span class="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
										<UsersIcon class="size-3.5" /> Tag
									</span>
									{#each participantNames as name (name)}
										<Button
											variant="secondary"
											size="sm"
											class="h-8 rounded-full px-3 text-xs"
											onclick={() => editor?.insertMention(name)}
										>
											@{name}
										</Button>
									{/each}
								</div>
							{/if}
						</header>
					{/if}

					<div class="relative">
						{#if !notes.markdown.trim()}
							<p
								class="pointer-events-none absolute left-0 top-0 select-none text-base leading-[1.5] text-muted-foreground/40"
							>
								Take notes…
							</p>
						{/if}
						<Editor bind:this={editor} value={initialNotes} onChange={(md) => notes.set(md)} />
					</div>
				</div>
			</div>
		</div>

		<StatusOverlays
			isProcessing={recordingState.status === RecordingStatus.PROCESSING_TRANSCRIPTS &&
				!recordingState.isRecording}
			isSaving={recordingState.status === RecordingStatus.SAVING}
		/>
	</div>
</div>
