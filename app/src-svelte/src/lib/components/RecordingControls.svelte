<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onMount } from 'svelte';
	import { AlertCircle, Mic, Pause, Play, Square, X } from '@lucide/svelte';

	import { Analytics } from '$lib/analytics';
	import Alert from '$lib/ui/alert.svelte';
	import Tooltip from '$lib/ui/tooltip.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import type { SelectedDevices } from '$lib/stores/config.svelte';

	interface Props {
		isRecording: boolean;
		barHeights: string[];
		onRecordingStop: (callApi?: boolean) => void;
		onRecordingStart: () => void;
		onStopInitiated?: () => void;
		onTranscriptionError?: (message: string) => void;
		isRecordingDisabled: boolean;
		isParentProcessing: boolean;
		selectedDevices?: SelectedDevices;
		meetingName?: string;
	}

	let {
		isRecording,
		barHeights,
		onRecordingStop,
		onRecordingStart,
		onStopInitiated,
		onTranscriptionError,
		isRecordingDisabled,
		isParentProcessing,
		selectedDevices,
		meetingName
	}: Props = $props();

	const isPaused = $derived(recordingState.isPaused);

	let isProcessing = $state(false);
	let isStarting = $state(false);
	let isStopping = $state(false);
	let isPausing = $state(false);
	let isResuming = $state(false);
	let isValidatingModel = $state(false);
	let deviceError = $state<{ title: string; message: string } | null>(null);

	async function handleStartRecording(): Promise<void> {
		if (isStarting || isValidatingModel) return;

		try {
			await onRecordingStart();
		} catch (error) {
			console.error('Failed to start recording:', error);
			const errorMsg = error instanceof Error ? error.message : String(error);

			if (
				errorMsg.includes('microphone') ||
				errorMsg.includes('mic') ||
				errorMsg.includes('input')
			) {
				deviceError = {
					title: 'Microphone Not Available',
					message:
						'Unable to access your microphone. Please check that:\n• Your microphone is connected\n• The app has microphone permissions\n• No other app is using the microphone'
				};
			} else if (
				errorMsg.includes('system audio') ||
				errorMsg.includes('speaker') ||
				errorMsg.includes('output')
			) {
				deviceError = {
					title: 'System Audio Not Available',
					message:
						'Unable to capture system audio. Please check that:\n• A virtual audio device (like BlackHole) is installed\n• The app has screen recording permissions (macOS)\n• System audio is properly configured'
				};
			} else if (errorMsg.includes('permission')) {
				deviceError = {
					title: 'Permission Required',
					message:
						'Recording permissions are required. Please:\n• Grant microphone access in System Settings\n• Grant screen recording access for system audio (macOS)\n• Restart the app after granting permissions'
				};
			} else {
				deviceError = {
					title: 'Recording Failed',
					message:
						'Unable to start recording. Please check your audio device settings and try again.'
				};
			}
		}
	}

	async function stopRecordingAction(): Promise<void> {
		try {
			isProcessing = true;
			const stopped = await recordingState.stop();
			isProcessing = false;
			if (stopped) {
				void Analytics.trackTranscriptionSuccess();
				onRecordingStop(true);
			} else {
				onRecordingStop(false);
			}
		} finally {
			isStopping = false;
		}
	}

	async function handleStopRecording(): Promise<void> {
		if (!isRecording || isStarting || isStopping) return;
		onStopInitiated?.();
		isStopping = true;
		await stopRecordingAction();
	}

	async function handlePauseRecording(): Promise<void> {
		if (!isRecording || isPaused || isPausing) return;
		isPausing = true;
		try {
			await recordingState.pause();
		} finally {
			isPausing = false;
		}
	}

	async function handleResumeRecording(): Promise<void> {
		if (!isRecording || !isPaused || isResuming) return;
		isResuming = true;
		try {
			await recordingState.resume();
		} finally {
			isResuming = false;
		}
	}

	onMount(() => {
		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;

		(async () => {
			try {
				await invoke('is_recording');
			} catch (error) {
				console.error('Tauri initialization error:', error);
			}

			try {
				const transcriptErrorUnsubscribe = await listen<string>('transcript-error', (event) => {
					const errorMessage = event.payload;
					void Analytics.trackTranscriptionError(errorMessage);
					isProcessing = false;
					onRecordingStop(false);
					onTranscriptionError?.(errorMessage);
				});
				if (cancelled) transcriptErrorUnsubscribe();
				else unsubscribers.push(transcriptErrorUnsubscribe);

				const transcriptionErrorUnsubscribe = await listen('transcription-error', (event) => {
					let errorMessage: string;
					if (typeof event.payload === 'object' && event.payload !== null) {
						const payload = event.payload as { error: string; userMessage: string };
						errorMessage = payload.userMessage || payload.error;
					} else {
						errorMessage = String(event.payload);
					}
					void Analytics.trackTranscriptionError(errorMessage);
					isProcessing = false;
					onRecordingStop(false);
				});
				if (cancelled) transcriptionErrorUnsubscribe();
				else unsubscribers.push(transcriptionErrorUnsubscribe);
			} catch (error) {
				console.error('Failed to set up recording event listeners:', error);
			}
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});
</script>

<div class="flex flex-col space-y-2">
	<div
		class="flex items-center space-x-2 rounded-full border border-border bg-card px-4 py-2 shadow-[0_8px_30px_rgb(0,0,0,0.08)]"
	>
		{#if isProcessing && !isParentProcessing}
			<div class="flex items-center space-x-2">
				<div class="size-5 animate-spin rounded-full border-b-2 border-foreground"></div>
				<span class="text-sm text-muted-foreground">Processing recording...</span>
			</div>
		{:else if !isRecording}
			<Tooltip>
				{#snippet trigger()}
					<button
						onclick={() => {
							void Analytics.trackButtonClick('start_recording', 'recording_controls');
							void handleStartRecording();
						}}
						disabled={isStarting || isProcessing || isRecordingDisabled || isValidatingModel}
						class={`relative flex size-12 items-center justify-center rounded-full text-white transition-colors ${
							isStarting || isProcessing || isValidatingModel
								? 'bg-muted-foreground/50'
								: 'bg-accent hover:opacity-90'
						}`}
					>
						{#if isValidatingModel}
							<div class="size-5 animate-spin rounded-full border-b-2 border-white"></div>
						{:else}
							<Mic size={20} />
						{/if}
					</button>
				{/snippet}
				{#snippet content()}<p>Start recording</p>{/snippet}
			</Tooltip>

			<div class="mx-4 flex items-center space-x-1">
				{#each barHeights as height, index (index)}
					<div
						class={`w-1 rounded-full transition-all duration-200 ${isPaused ? 'bg-muted-foreground/60' : 'bg-accent'}`}
						style={`height: ${isRecording && !isPaused ? height : '4px'}; opacity: ${isPaused ? 0.6 : 1};`}
					></div>
				{/each}
			</div>
		{:else}
			<Tooltip>
				{#snippet trigger()}
					<button
						onclick={() => {
							if (isPaused) {
								void Analytics.trackButtonClick('resume_recording', 'recording_controls');
								void handleResumeRecording();
							} else {
								void Analytics.trackButtonClick('pause_recording', 'recording_controls');
								void handlePauseRecording();
							}
						}}
						disabled={isPausing || isResuming || isStopping}
						class={`relative flex size-10 items-center justify-center rounded-full border-2 transition-colors ${
							isPausing || isResuming || isStopping
								? 'border-border bg-secondary text-muted-foreground'
								: 'border-border bg-card text-muted-foreground hover:bg-secondary'
						}`}
					>
						{#if isPaused}<Play size={16} />{:else}<Pause size={16} />{/if}
						{#if isPausing || isResuming}
							<div class="absolute -top-8 text-xs font-medium text-muted-foreground">
								{isPausing ? 'Pausing...' : 'Resuming...'}
							</div>
						{/if}
					</button>
				{/snippet}
				{#snippet content()}<p>{isPaused ? 'Resume recording' : 'Pause recording'}</p>{/snippet}
			</Tooltip>

			<Tooltip>
				{#snippet trigger()}
					<button
						onclick={() => {
							void Analytics.trackButtonClick('stop_recording', 'recording_controls');
							void handleStopRecording();
						}}
						disabled={isStopping || isPausing || isResuming}
						class={`relative flex size-10 items-center justify-center rounded-full text-white transition-colors ${
							isStopping || isPausing || isResuming
								? 'bg-muted-foreground/50'
								: 'bg-destructive hover:opacity-90'
						}`}
					>
						<Square size={16} />
						{#if isStopping}
							<div class="absolute -top-8 text-xs font-medium text-muted-foreground">
								Stopping...
							</div>
						{/if}
					</button>
				{/snippet}
				{#snippet content()}<p>Stop recording</p>{/snippet}
			</Tooltip>

			<div class="mx-4 flex items-center space-x-1">
				{#each barHeights as height, index (index)}
					<div
						class={`w-1 rounded-full transition-all duration-200 ${isPaused ? 'bg-muted-foreground/60' : 'bg-accent'}`}
						style={`height: ${isRecording && !isPaused ? height : '4px'}; opacity: ${isPaused ? 0.6 : 1};`}
					></div>
				{/each}
			</div>
		{/if}
	</div>

	{#if isValidatingModel}
		<div class="mt-2 text-center text-xs text-muted-foreground">
			Validating speech recognition...
		</div>
	{/if}

	{#if deviceError}
		{@const lines = deviceError.message.split('\n')}
		{@const errorTitle = deviceError.title}
		<Alert variant="destructive" class="mt-4">
			{#snippet icon()}<AlertCircle class="size-5" />{/snippet}
			{#snippet title()}<span>{errorTitle}</span>{/snippet}
			<button
				onclick={() => (deviceError = null)}
				class="absolute right-3 top-3 text-destructive transition-colors hover:opacity-80"
				aria-label="Close alert"
			>
				<X class="size-4" />
			</button>
			{#each lines as line, i (i)}
				<div class={i > 0 ? 'ml-2' : ''}>{line}</div>
			{/each}
		</Alert>
	{/if}
</div>
