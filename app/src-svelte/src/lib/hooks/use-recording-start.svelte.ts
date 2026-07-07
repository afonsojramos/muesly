/**
 * useRecordingStart
 *
 * Manages the recording start lifecycle: manual start (button), auto-start from
 * sidebar navigation (sessionStorage flag), and the direct
 * `start-recording-from-sidebar` window event when already on the home route.
 *
 * Mirrors the React useRecordingStart hook. State that lived in React contexts
 * is read from the Svelte stores (config, transcripts, sidebar, recordingState).
 */

import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

import { Analytics } from '$lib/analytics';
import { recordingService } from '$lib/services/recording';
import { showRecordingNotification } from '$lib/recording-notification';
import { toast } from '$lib/toast';
import { config } from '$lib/stores/config.svelte';
import { recordingState, RecordingStatus } from '$lib/stores/recording-state.svelte';
import { sidebar } from '$lib/stores/sidebar.svelte';
import { transcripts } from '$lib/stores/transcript.svelte';

const isBrowser = typeof window !== 'undefined';

interface ModelStatus {
	status?: unknown;
}

export interface UseRecordingStart {
	readonly isAutoStarting: boolean;
	handleRecordingStart: () => Promise<void>;
}

function generateMeetingTitle(): string {
	const now = new Date();
	const day = String(now.getDate()).padStart(2, '0');
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const year = String(now.getFullYear()).slice(-2);
	const hours = String(now.getHours()).padStart(2, '0');
	const minutes = String(now.getMinutes()).padStart(2, '0');
	const seconds = String(now.getSeconds()).padStart(2, '0');
	return `Meeting ${day}_${month}_${year}_${hours}_${minutes}_${seconds}`;
}

async function checkParakeetReady(): Promise<boolean> {
	try {
		await invoke('parakeet_init');
		return await invoke<boolean>('parakeet_has_available_models');
	} catch (error) {
		console.error('Failed to check Parakeet status:', error);
		return false;
	}
}

async function checkIfModelDownloading(): Promise<boolean> {
	try {
		const models = await invoke<ModelStatus[]>('parakeet_get_available_models');
		return models.some((m) => {
			if (!m.status) return false;
			return typeof m.status === 'object'
				? 'Downloading' in (m.status as Record<string, unknown>)
				: m.status === 'Downloading';
		});
	} catch (error) {
		console.error('Failed to check model download status:', error);
		return false;
	}
}

/**
 * Start a recording with an explicit title (e.g. a calendar event name), from
 * anywhere. Mirrors `startBackendRecording` + the readiness check, without the
 * hook's local UI callbacks. Surfaces a toast instead of throwing so callers
 * (like the "Coming up" Start button) can fire-and-forget.
 */
export async function startRecordingWithTitle(
	title: string,
	location = 'coming_up',
): Promise<void> {
	if (recordingState.isRecording) return;
	const parakeetReady = await checkParakeetReady();
	if (!parakeetReady) {
		toast.error('Transcription model not ready', {
			description: 'Please download a transcription model before recording.',
		});
		recordingState.setStatus(RecordingStatus.IDLE);
		return;
	}
	try {
		recordingState.setStatus(RecordingStatus.STARTING, 'Initializing recording...');
		await recordingService.startRecordingWithDevices(
			config.selectedDevices.micDevice || null,
			config.selectedDevices.systemDevice || null,
			title,
		);
		transcripts.setMeetingTitle(title);
		recordingState.markStarted();
		transcripts.clearTranscripts();
		sidebar.setIsMeetingActive(true);
		await showRecordingNotification();
		void Analytics.trackButtonClick('start_recording', location);
	} catch (error) {
		console.error('Failed to start recording:', error);
		recordingState.setStatus(
			RecordingStatus.ERROR,
			error instanceof Error ? error.message : 'Failed to start recording',
		);
		toast.error('Failed to start recording', {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

export function useRecordingStart(
	setIsRecording: (value: boolean) => void,
	showModal?: (name: 'modelSelector', message?: string) => void,
): UseRecordingStart {
	let isAutoStarting = $state(false);

	const notifyModelNotReady = async (location: string): Promise<void> => {
		const isDownloading = await checkIfModelDownloading();
		if (isDownloading) {
			toast.info('Model download in progress', {
				description:
					'Please wait for the transcription model to finish downloading before recording.',
				duration: 5000,
			});
			void Analytics.trackButtonClick('start_recording_blocked_downloading', location);
		} else {
			toast.error('Transcription model not ready', {
				description: 'Please download a transcription model before recording.',
				duration: 5000,
			});
			showModal?.('modelSelector', 'Transcription model setup required');
			void Analytics.trackButtonClick('start_recording_blocked_missing', location);
		}
		recordingState.setStatus(RecordingStatus.IDLE);
	};

	const startBackendRecording = async (title: string): Promise<void> => {
		recordingState.setStatus(RecordingStatus.STARTING, 'Initializing recording...');
		await recordingService.startRecordingWithDevices(
			config.selectedDevices.micDevice || null,
			config.selectedDevices.systemDevice || null,
			title,
		);
		transcripts.setMeetingTitle(title);
		// Optimistically flip UI state (mirrors React). The `recording-started`
		// event listener calls the same method, so this is idempotent.
		recordingState.markStarted();
		setIsRecording(true);
		transcripts.clearTranscripts();
		sidebar.setIsMeetingActive(true);
		await showRecordingNotification();
	};

	const handleRecordingStart = async (): Promise<void> => {
		try {
			const parakeetReady = await checkParakeetReady();
			if (!parakeetReady) {
				await notifyModelNotReady('home_page');
				return;
			}

			const title = generateMeetingTitle();
			await startBackendRecording(title);
			void Analytics.trackButtonClick('start_recording', 'home_page');
		} catch (error) {
			console.error('Failed to start recording:', error);
			recordingState.setStatus(
				RecordingStatus.ERROR,
				error instanceof Error ? error.message : 'Failed to start recording',
			);
			setIsRecording(false);
			void Analytics.trackButtonClick('start_recording_error', 'home_page');
			// Re-throw so RecordingControls can surface device-specific errors.
			throw error;
		}
	};

	const autoStart = async (location: string): Promise<void> => {
		if (recordingState.isRecording || isAutoStarting) return;
		isAutoStarting = true;

		try {
			const parakeetReady = await checkParakeetReady();
			if (!parakeetReady) {
				await notifyModelNotReady(location);
				return;
			}

			const title = generateMeetingTitle();
			await startBackendRecording(title);
			void Analytics.trackButtonClick('start_recording', location);
		} catch (error) {
			console.error(`Failed to ${location} recording:`, error);
			recordingState.setStatus(
				RecordingStatus.ERROR,
				error instanceof Error ? error.message : 'Failed to start recording',
			);
			void Analytics.trackButtonClick('start_recording_error', location);
		} finally {
			isAutoStarting = false;
		}
	};

	onMount(() => {
		// Auto-start from navigation (sidebar set a sessionStorage flag).
		if (isBrowser && sessionStorage.getItem('autoStartRecording') === 'true') {
			sessionStorage.removeItem('autoStartRecording');
			void autoStart('sidebar_auto');
		}

		// Direct start when already on the home route.
		const handleDirectStart = (): void => {
			void autoStart('sidebar_direct');
		};
		if (isBrowser) {
			window.addEventListener('start-recording-from-sidebar', handleDirectStart);
		}

		return () => {
			if (isBrowser) {
				window.removeEventListener('start-recording-from-sidebar', handleDirectStart);
			}
		};
	});

	return {
		get isAutoStarting() {
			return isAutoStarting;
		},
		handleRecordingStart,
	};
}
