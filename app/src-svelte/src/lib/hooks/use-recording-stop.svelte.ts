/**
 * useRecordingStop
 *
 * Manages the recording stop lifecycle: transcription-completion wait → buffer
 * flush → SQLite save → navigation. Mirrors the React useRecordingStop hook.
 *
 * `stop_recording` itself is already called by the recording controls (pill /
 * bar); this hook only handles post-stop processing.
 */

import { goto } from '$app/navigation';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onMount } from 'svelte';

import { Analytics } from '$lib/analytics';
import { backgroundTasks } from '$lib/stores/background-tasks.svelte';
import { commands } from '$lib/bindings';
import { FOLDER_PIN_KEY } from '$lib/hooks/use-recording-start.svelte';
import { storageService } from '$lib/services/storage';
import { transcriptService } from '$lib/services/transcript';
import { toast } from '$lib/toast';
import { config } from '$lib/stores/config.svelte';
import { notes } from '$lib/stores/notes.svelte';
import { recordingState, RecordingStatus } from '$lib/stores/recording-state.svelte';
import { sidebar } from '$lib/stores/sidebar.svelte';
import { transcripts } from '$lib/stores/transcript.svelte';

const isBrowser = typeof window !== 'undefined';

/** Upper bound on waiting for the post-meeting quality pass (long meetings). */
const QUALITY_PASS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Re-transcribe the saved recording with the batch pipeline (merged VAD
 * windows, no realtime pressure) and wait for it to finish, so speaker
 * identification runs against the final segments. Local engines only.
 */
async function runQualityPass(meetingId: string, folderPath: string): Promise<void> {
	const provider = config.transcriptModelConfig?.provider === 'parakeet' ? 'parakeet' : 'whisper';
	const model = config.transcriptModelConfig?.model ?? null;
	const langRes = await commands.getTranscriptionLanguage();
	const language = langRes.status === 'ok' && langRes.data !== 'auto' ? langRes.data : null;

	const completion = new Promise<void>((resolve) => {
		let unComplete: UnlistenFn | undefined;
		let unError: UnlistenFn | undefined;
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			unComplete?.();
			unError?.();
			resolve();
		};
		const matches = (payload: unknown): boolean =>
			(payload as { meeting_id?: string })?.meeting_id === meetingId;
		void listen('retranscription-complete', (e) => {
			if (matches(e.payload)) finish();
		}).then((u) => (unComplete = u));
		void listen('retranscription-error', (e) => {
			if (matches(e.payload)) finish();
		}).then((u) => (unError = u));
		setTimeout(finish, QUALITY_PASS_TIMEOUT_MS);
	});

	backgroundTasks.begin('retranscription', meetingId, 'Quality pass: re-transcribing');
	const started = await commands.startRetranscriptionCommand(
		meetingId,
		folderPath,
		language,
		model,
		provider,
	);
	if (started.status === 'error') {
		console.error('Quality pass failed to start:', started.error);
		// The task is only terminated by retranscription-complete/-error events, and
		// a failed start emits neither — end it here so it doesn't linger forever.
		backgroundTasks.finish(
			'retranscription',
			meetingId,
			'error',
			started.error ?? 'Failed to start',
		);
		return;
	}
	await completion;
}

declare global {
	interface Window {
		handleRecordingStop?: (callApi?: boolean) => void;
	}
}

export interface UseRecordingStop {
	handleRecordingStop: (callApi: boolean) => Promise<void>;
	setIsStopping: (value: boolean) => void;
}

export function useRecordingStop(
	setIsRecording: (value: boolean) => void,
	setIsRecordingDisabled: (value: boolean) => void,
): UseRecordingStop {
	// Guard against duplicate/concurrent stop calls (UI + tray).
	let stopInProgress = false;
	// Resolves once the recording-stopped event payload has been persisted to
	// sessionStorage, fixing a race with recording-stop-complete.
	let recordingStoppedData: Promise<void> | null = null;

	const handleRecordingStop = async (isCallApi: boolean): Promise<void> => {
		if (recordingStoppedData) {
			await recordingStoppedData;
		}

		if (stopInProgress) return;
		stopInProgress = true;

		recordingState.setStatus(RecordingStatus.STOPPING);
		setIsRecording(false);
		setIsRecordingDisabled(true);

		try {
			recordingState.setStatus(
				RecordingStatus.PROCESSING_TRANSCRIPTS,
				'Waiting for transcription...',
			);

			const MAX_WAIT_TIME = 60000;
			const POLL_INTERVAL = 500;
			let elapsedTime = 0;
			let transcriptionComplete = false;

			const unlistenComplete = await listen('transcription-complete', () => {
				transcriptionComplete = true;
			});

			while (elapsedTime < MAX_WAIT_TIME && !transcriptionComplete) {
				try {
					const status = await transcriptService.getTranscriptionStatus();

					if (!status.is_processing && status.chunks_in_queue === 0) {
						transcriptionComplete = true;
						break;
					}

					if (status.last_activity_ms > 8000 && status.chunks_in_queue === 0) {
						transcriptionComplete = true;
						break;
					}

					if (status.chunks_in_queue > 0) {
						recordingState.setStatus(
							RecordingStatus.PROCESSING_TRANSCRIPTS,
							`Processing ${status.chunks_in_queue} remaining chunks...`,
						);
					}

					await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
					elapsedTime += POLL_INTERVAL;
				} catch (error) {
					console.error('Error checking transcription status:', error);
					break;
				}
			}

			unlistenComplete();

			if (!transcriptionComplete && elapsedTime >= MAX_WAIT_TIME) {
				console.warn('Transcription wait timeout reached after', elapsedTime, 'ms');
			} else {
				// Wait for any late transcript segments.
				await new Promise((resolve) => setTimeout(resolve, 4000));
			}

			recordingState.setStatus(
				RecordingStatus.PROCESSING_TRANSCRIPTS,
				'Flushing transcript buffer...',
			);
			transcripts.flushBuffer();

			await new Promise((resolve) => setTimeout(resolve, 500));

			// Save on any normal stop, even if transcription never signalled completion
			// (a timed-out wait or a status-check error must not silently discard the
			// recording — the audio and whatever transcripts we have still get saved).
			if (isCallApi) {
				if (!transcriptionComplete) {
					console.warn('[RecordingStop] Saving despite incomplete transcription wait');
				}
				recordingState.setStatus(RecordingStatus.SAVING, 'Saving meeting to database...');

				const freshTranscripts = [...transcripts.transcripts];

				const folderPath = isBrowser ? sessionStorage.getItem('last_recording_folder_path') : null;
				const savedMeetingName = isBrowser
					? sessionStorage.getItem('last_recording_meeting_name')
					: null;

				try {
					const responseData = await storageService.saveMeeting(
						savedMeetingName || transcripts.meetingTitle || 'New Meeting',
						freshTranscripts,
						folderPath,
					);

					const meetingId = responseData.meeting_id;
					if (!meetingId) {
						throw new Error('No meeting ID received from save operation');
					}

					// Persist the user's in-meeting notes before navigation so they're in
					// SQLite by the time the summary auto-generates (which reads them as
					// context). A notes-save failure must not abort the meeting save.
					const notesMarkdown = notes.markdown.trim();
					if (notesMarkdown) {
						try {
							await storageService.saveMeetingNotes(meetingId, notesMarkdown);
						} catch (notesError) {
							console.error('Failed to save meeting notes:', notesError);
							toast.error('Failed to save meeting notes', {
								description: notesError instanceof Error ? notesError.message : 'Unknown error',
							});
						}
					}

					// Attach the calendar event happening at record time so the summary
					// can use it. Only when the user enabled calendar context; failure
					// is non-fatal and must never abort the meeting save.
					try {
						const enabled = await commands.calendarGetContextEnabled();
						if (enabled.status === 'ok' && enabled.data) {
							await commands.calendarAttachEvent(meetingId);
						}
					} catch (calendarError) {
						console.error('Failed to attach calendar event:', calendarError);
					}

					// Optional post-meeting quality pass: replace the live segments with
					// a batch re-transcription of the saved audio. Awaited so speaker
					// identification below labels the final segments, and gated to
					// local engines (never re-bills a cloud provider). Best-effort.
					try {
						const qp = await commands.getPostMeetingQualityPassEnabled();
						const provider = config.transcriptModelConfig?.provider;
						const isLocalEngine = provider === 'localWhisper' || provider === 'parakeet';
						if (qp.status === 'ok' && qp.data && isLocalEngine && folderPath) {
							await runQualityPass(meetingId, folderPath);
						}
					} catch (qualityError) {
						console.error('Post-meeting quality pass failed:', qualityError);
					}

					// Auto-identify speakers for a calendar meeting with attendees, but
					// only when the model is already present (never trigger a large
					// download mid-flow). Best-effort and backgrounded: it must never
					// block or fail the stop. The manual "Speakers" button covers the
					// rest (no attendees, or model not yet downloaded).
					try {
						const speakers = await commands.getMeetingSpeakers(meetingId);
						const hasAttendees = speakers.status === 'ok' && speakers.data.shortlist.length > 0;
						if (hasAttendees) {
							const ready = await commands.diarizationModelsReady();
							if (ready.status === 'ok' && ready.data) {
								void commands.diarizeMeeting(meetingId);
							}
						}
					} catch (diarizeError) {
						console.error('Failed to auto-identify speakers:', diarizeError);
					}

					// If this recording was started from a specific calendar event (the
					// "Coming up" Start button pins its identity), file the note into the
					// folder pre-assigned to that event. Runs regardless of the context
					// toggle, and uses the exact event rather than re-matching.
					const pinned = isBrowser ? sessionStorage.getItem(FOLDER_PIN_KEY) : null;
					if (pinned) {
						sessionStorage.removeItem(FOLDER_PIN_KEY);
						try {
							const { icalUid, occurrenceMinute } = JSON.parse(pinned) as {
								icalUid: string;
								occurrenceMinute: number;
							};
							await commands.calendarApplyFolderRule(meetingId, icalUid, occurrenceMinute);
						} catch (pinError) {
							console.error('Failed to apply pre-assigned folder:', pinError);
						}
					}

					await transcripts.markMeetingAsSaved();

					if (isBrowser) {
						sessionStorage.removeItem('last_recording_folder_path');
						sessionStorage.removeItem('last_recording_meeting_name');
						sessionStorage.removeItem('indexeddb_current_meeting_id');
					}

					await sidebar.refetchMeetings();

					// Auto-generate a concise title in the background so finished meetings
					// aren't left as "New Meeting". When full auto-summary is enabled the
					// summary already sets the title, so skip the extra call then.
					if (!config.isAutoSummary) {
						const provider = config.modelConfig?.provider;
						const model = config.modelConfig?.model;
						const { formatTranscriptForLlm } = await import('$lib/format-transcript-for-llm');
						const titleText = formatTranscriptForLlm(freshTranscripts);

						if (provider && model && titleText) {
							void invoke('api_generate_meeting_title', {
								meetingId,
								text: titleText,
								model: provider,
								modelName: model,
							})
								.then(() => sidebar.refetchMeetings())
								.catch((err) => console.error('Auto title generation failed:', err));
						}
					}

					try {
						const meetingData = await storageService.getMeeting(meetingId);
						if (meetingData) {
							sidebar.setCurrentMeeting({ id: meetingId, title: meetingData.title });
						}
					} catch (error) {
						console.warn('Could not fetch meeting details, using ID only:', error);
						sidebar.setCurrentMeeting({
							id: meetingId,
							title: savedMeetingName || transcripts.meetingTitle || 'New Meeting',
						});
					}

					recordingState.setStatus(RecordingStatus.COMPLETED);

					toast.success('Recording saved successfully!', {
						description: `${freshTranscripts.length} transcript segments saved.`,
						action: {
							label: 'View Meeting',
							onClick: () => {
								void goto(`/meeting-details?id=${meetingId}`);
								void Analytics.trackButtonClick('view_meeting_from_toast', 'recording_complete');
							},
						},
						duration: 10000,
					});

					setTimeout(() => {
						void goto(`/meeting-details?id=${meetingId}&source=recording`);
						transcripts.clearTranscripts();
						notes.clear();
						void Analytics.trackPageView('meeting_details');
						recordingState.setStatus(RecordingStatus.IDLE);
					}, 2000);

					try {
						let durationSeconds = 0;
						const firstTranscript = freshTranscripts[0];
						if (firstTranscript && firstTranscript.audio_start_time !== undefined) {
							const lastTranscript = freshTranscripts[freshTranscripts.length - 1];
							durationSeconds =
								lastTranscript?.audio_end_time ?? lastTranscript?.audio_start_time ?? 0;
						}

						const transcriptWordCount = freshTranscripts
							.map((t) => t.text.split(/\s+/).length)
							.reduce((a, b) => a + b, 0);

						const wordsPerMinute =
							durationSeconds > 0 ? transcriptWordCount / (durationSeconds / 60) : 0;

						const meetingsToday = await Analytics.getMeetingsCountToday();

						await Analytics.trackMeetingCompleted(meetingId, {
							duration_seconds: durationSeconds,
							transcript_segments: freshTranscripts.length,
							transcript_word_count: transcriptWordCount,
							words_per_minute: wordsPerMinute,
							meetings_today: meetingsToday,
						});

						await Analytics.updateMeetingCount();

						const { Store } = await import('@tauri-apps/plugin-store');
						const store = await Store.load('analytics.json');
						const totalMeetings = await store.get<number>('total_meetings');

						if (totalMeetings === 1) {
							const daysSinceInstall = await Analytics.calculateDaysSince('first_launch_date');
							await Analytics.track('user_activated', {
								meetings_count: '1',
								days_since_install: daysSinceInstall?.toString() || 'null',
								first_meeting_duration_seconds: durationSeconds.toString(),
							});
						}
					} catch (analyticsError) {
						console.error('Failed to track meeting completion analytics:', analyticsError);
					}
				} catch (saveError) {
					console.error('Failed to save meeting to database:', saveError);
					recordingState.setStatus(
						RecordingStatus.ERROR,
						saveError instanceof Error ? saveError.message : 'Unknown error',
					);
					toast.error('Failed to save meeting', {
						description: saveError instanceof Error ? saveError.message : 'Unknown error',
					});
					throw saveError;
				}
			} else {
				recordingState.setStatus(RecordingStatus.IDLE);
			}

			sidebar.setIsMeetingActive(false);
			setIsRecordingDisabled(false);
		} catch (error) {
			console.error('Error in handleRecordingStop:', error);
			recordingState.setStatus(
				RecordingStatus.ERROR,
				error instanceof Error ? error.message : 'Unknown error',
			);
			setIsRecordingDisabled(false);
		} finally {
			stopInProgress = false;
		}
	};

	onMount(() => {
		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;

		(async () => {
			try {
				const unlisten = await listen<{
					message: string;
					folder_path?: string;
					meeting_name?: string;
				}>('recording-stopped', (event) => {
					recordingStoppedData = (async () => {
						const { folder_path, meeting_name } = event.payload;
						if (isBrowser && folder_path) {
							sessionStorage.setItem('last_recording_folder_path', folder_path);
						}
						if (isBrowser && meeting_name) {
							sessionStorage.setItem('last_recording_meeting_name', meeting_name);
						}
					})();
				});
				if (cancelled) unlisten();
				else unsubscribers.push(unlisten);
			} catch (error) {
				console.error('Failed to setup recording stopped listener:', error);
			}
		})();

		// Expose to window for Rust callbacks.
		if (isBrowser) {
			window.handleRecordingStop = (callApi = true) => {
				void handleRecordingStop(callApi);
			};
		}

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
			if (isBrowser) {
				delete window.handleRecordingStop;
			}
		};
	});

	return {
		handleRecordingStop,
		setIsStopping: (value: boolean) => {
			recordingState.setStatus(value ? RecordingStatus.STOPPING : RecordingStatus.IDLE);
		},
	};
}
