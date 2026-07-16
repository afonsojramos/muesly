/**
 * useSummaryGeneration
 *
 * Drives AI summary generation: validates the configured provider/model,
 * fetches all transcripts, kicks off the backend process, and polls for the
 * result via the sidebar store. Markdown-first — legacy section formats are
 * still accepted on the way in but the new flow only emits `{ markdown }`.
 *
 * Reactive inputs are supplied via getters so the hook tracks changes to the
 * meeting, model config, and selected template.
 */

import { onDestroy } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { Summary, Transcript } from '$lib/types';
import type { ModelConfig } from '$lib/services/config';
import type { BuiltInModelInfo } from '$lib/ai/builtin-ai';
import { Analytics } from '$lib/analytics';
import { commands } from '$lib/bindings';
import { sidebar } from '$lib/stores/sidebar.svelte';
import { toast } from '$lib/toast';
import { formatRecordingTimestamp } from '$lib/utils/format-time';
import { isOllamaNotInstalledError } from '$lib/utils';

export type SummaryStatus =
	| 'idle'
	| 'processing'
	| 'cleanup'
	| 'summarizing'
	| 'regenerating'
	| 'completed'
	| 'error';

interface MeetingShape {
	id: string;
	created_at: string;
}

interface PaginatedTranscripts {
	transcripts: Transcript[];
	total_count: number;
	has_more: boolean;
}

interface SummaryPollResult {
	status: string;
	error?: string;
	data?: Record<string, unknown> & {
		markdown?: string;
		MeetingName?: string;
		_section_order?: string[];
	};
	meetingName?: string;
	[key: string]: unknown;
}

interface ProcessSummaryOptions {
	transcriptText: string;
	customPrompt?: string;
	isRegeneration?: boolean;
}

export interface UseSummaryGenerationOptions {
	getMeeting: () => MeetingShape;
	getModelConfig: () => ModelConfig;
	getIsModelConfigLoading: () => boolean;
	getSelectedTemplate: () => string;
	/** BCP-47 code for the desired summary output language (empty/undefined = auto/English). */
	getSummaryLanguage?: () => string | null | undefined;
	/** The user's in-meeting notes (markdown), folded into the generation context. */
	getNotesMarkdown?: () => string;
	onMeetingUpdated?: () => Promise<void>;
	updateMeetingTitle: (title: string) => void;
	setAiSummary: (summary: Summary | null) => void;
	onOpenModelSettings?: () => void;
}

export interface UseSummaryGeneration {
	readonly summaryStatus: SummaryStatus;
	readonly summaryError: string | null;
	handleGenerateSummary: (customPrompt?: string) => Promise<void>;
	handleRegenerateSummary: () => Promise<void>;
	handleStopGeneration: () => Promise<void>;
}

export function useSummaryGeneration(options: UseSummaryGenerationOptions): UseSummaryGeneration {
	const {
		getMeeting,
		getModelConfig,
		getIsModelConfigLoading,
		getSelectedTemplate,
		getSummaryLanguage,
		getNotesMarkdown,
		onMeetingUpdated,
		updateMeetingTitle,
		setAiSummary,
		onOpenModelSettings,
	} = options;

	// Fold the user's notes into the LLM "user context" alongside any free-text
	// custom prompt. The backend wraps this in <user_context> for the prompt.
	const buildGenerationContext = (customPrompt: string): string => {
		const notesMarkdown = getNotesMarkdown?.().trim() ?? '';
		const blocks: string[] = [];
		if (notesMarkdown) {
			blocks.push(
				`The user's own notes taken during the meeting:\n<user_notes>\n${notesMarkdown}\n</user_notes>`,
			);
		}
		if (customPrompt.trim()) {
			blocks.push(customPrompt.trim());
		}
		return blocks.join('\n\n');
	};

	let summaryStatus = $state<SummaryStatus>('idle');
	let summaryError = $state<string | null>(null);
	let originalTranscript = '';

	// A generation started on a previous visit may still be running (its poll
	// and background task survive navigation with the view callback detached).
	// Re-attach a minimal terminal handler so this view tracks it live; the
	// richer regeneration-specific handling only matters to the session that
	// started the run.
	{
		const meetingId = getMeeting()?.id;
		if (meetingId) {
			const resumed = sidebar.reattachSummaryUpdates(meetingId, (result) => {
				if (result.status === 'completed') {
					void (async () => {
						try {
							const existing = (await invoke('api_get_summary', { meetingId })) as {
								data?: Summary | null;
							};
							if (existing?.data) setAiSummary(existing.data);
							summaryStatus = 'completed';
							summaryError = null;
						} catch (error) {
							console.error('Failed to load summary after resumed generation:', error);
							summaryStatus = 'idle';
						}
					})();
				} else if (result.status === 'error' || result.status === 'failed') {
					summaryStatus = 'error';
					summaryError = result.error ?? 'Summary generation failed';
				} else if (result.status === 'cancelled') {
					summaryStatus = 'idle';
				}
			});
			if (resumed) summaryStatus = 'summarizing';
		}
	}
	// Remembered so Regenerate can reuse the user's steering instead of dropping it.
	let lastCustomPrompt = '';
	let phaseUnlisten: UnlistenFn | null = null;

	// Steer the model to keep a few bracketed timestamps so the summary UI can turn
	// them into clickable transcript jumps.
	const TIMESTAMP_HINT =
		'When referencing a moment, include a bracketed timestamp like [01:05] from the transcript lines.';

	// A generation is already in flight — used to block a concurrent trigger (the
	// backend single-flights too, but this avoids a redundant round-trip).
	const isGenerating = (): boolean =>
		summaryStatus === 'processing' ||
		summaryStatus === 'cleanup' ||
		summaryStatus === 'summarizing' ||
		summaryStatus === 'regenerating';

	/** Fetch + speaker-label + timestamp-format the meeting's full transcript. */
	async function buildFullTranscript(meetingId: string): Promise<string> {
		const allTranscripts = await fetchAllTranscripts(meetingId);
		if (allTranscripts.length === 0) return '';

		// Prefer named speakers when the meeting has them (loaded best-effort).
		let speakerNames: Map<number, string> | undefined;
		let selfName: string | undefined;
		try {
			const res = await commands.getMeetingSpeakers(meetingId);
			if (res.status === 'ok') {
				speakerNames = new Map(
					res.data.speakers
						.filter((s): s is { speaker_id: number; name: string } => s.name != null)
						.map((s) => [s.speaker_id, s.name]),
				);
				selfName = res.data.self_name ?? undefined;
			}
		} catch {
			// Non-fatal: fall back to Me/Them labels.
		}

		const { formatTranscriptForLlm } = await import('$lib/format-transcript-for-llm');
		return formatTranscriptForLlm(allTranscripts, {
			names: speakerNames,
			selfName,
			includeTimestamps: true,
			formatTime: (start, ts) =>
				formatTime(typeof start === 'number' ? start : undefined, typeof ts === 'string' ? ts : ''),
		});
	}

	function teardownPhaseListener(): void {
		phaseUnlisten?.();
		phaseUnlisten = null;
	}

	// Unmounting mid-generation (stopSummaryPolling clears the interval, so the
	// terminal teardown never runs) otherwise leaks the `summary-phase` listener.
	onDestroy(teardownPhaseListener);

	async function bindPhaseListener(meetingId: string): Promise<void> {
		teardownPhaseListener();
		try {
			phaseUnlisten = await listen<{ meeting_id?: string; phase?: string }>(
				'summary-phase',
				(ev) => {
					const p = ev.payload;
					if (!p || p.meeting_id !== meetingId) return;
					if (p.phase === 'cleanup') {
						summaryStatus = 'cleanup';
					} else if (p.phase === 'summarizing' && summaryStatus === 'cleanup') {
						summaryStatus = 'summarizing';
					}
				},
			);
		} catch {
			// Non-fatal: status still advances via polling.
		}
	}

	const processSummary = async ({
		transcriptText,
		customPrompt = '',
		isRegeneration = false,
	}: ProcessSummaryOptions): Promise<void> => {
		const meeting = getMeeting();
		const modelConfig = getModelConfig();
		const selectedTemplate = getSelectedTemplate();

		summaryStatus = isRegeneration ? 'regenerating' : 'processing';
		summaryError = null;

		try {
			if (!transcriptText.trim()) {
				throw new Error('No transcript text available. Please add some text first.');
			}

			if (!isRegeneration) {
				originalTranscript = transcriptText;
			}

			const timeSinceRecording = (Date.now() - new Date(meeting.created_at).getTime()) / 60000;

			await Analytics.trackSummaryGenerationStarted(
				modelConfig.provider,
				modelConfig.model,
				transcriptText.length,
				timeSinceRecording,
			);

			if (customPrompt.trim().length > 0) {
				await Analytics.trackCustomPromptUsed(customPrompt.trim().length);
			}

			// The cleanup phase (when enabled) is surfaced by the backend's
			// summary-phase events; no need to pre-fetch the setting here.
			await bindPhaseListener(meeting.id);

			toast.info(`${isRegeneration ? 'Regenerating' : 'Generating'} summary...`, {
				description: `Using ${modelConfig.provider}/${modelConfig.model}`,
				duration: 3000,
			});

			const result = (await invoke('api_process_transcript', {
				params: {
					text: transcriptText,
					model: modelConfig.provider,
					modelName: modelConfig.model,
					meetingId: meeting.id,
					chunkSize: 40000,
					overlap: 1000,
					customPrompt: customPrompt,
					templateId: selectedTemplate,
					summaryLanguage: getSummaryLanguage?.() ?? null,
				},
			})) as { process_id: string };

			const processId = result.process_id;

			sidebar.startSummaryPolling(
				meeting.id,
				processId,
				async (pollingResult: SummaryPollResult) => {
					// Polling only reports terminal states; drop the phase listener so a
					// stray late `summary-phase` event can't flip the status back.
					teardownPhaseListener();
					if (pollingResult.status === 'cancelled') {
						try {
							const existing = (await invoke('api_get_summary', {
								meetingId: meeting.id,
							})) as { data?: Summary | null };
							if (existing?.data) {
								setAiSummary(existing.data);
								summaryStatus = 'completed';
							} else {
								summaryStatus = 'idle';
							}
						} catch (error) {
							console.error('Failed to reload summary after cancellation:', error);
							summaryStatus = 'idle';
						}
						summaryError = null;
						return;
					}

					if (pollingResult.status === 'error' || pollingResult.status === 'failed') {
						const errorMessage =
							pollingResult.error ||
							`Summary ${isRegeneration ? 'regeneration' : 'generation'} failed`;

						if (isRegeneration) {
							try {
								const existing = (await invoke('api_get_summary', {
									meetingId: meeting.id,
								})) as { data?: Summary | null };
								if (existing?.data) {
									setAiSummary(existing.data);
									summaryStatus = 'completed';
									summaryError = null;
									toast.error('Failed to regenerate summary', {
										description: `${errorMessage}. Your previous summary has been restored.`,
									});
									await Analytics.trackSummaryGenerationCompleted(
										modelConfig.provider,
										modelConfig.model,
										false,
										undefined,
										errorMessage,
									);
									return;
								}
							} catch (error) {
								console.error('Failed to reload summary after error:', error);
							}
						}

						summaryError = errorMessage;
						summaryStatus = 'error';

						const lower = errorMessage.toLowerCase();
						const isModelRequiredError =
							errorMessage.includes('model is required') ||
							errorMessage.includes('"model":"required"') ||
							(lower.includes('model') && lower.includes('required'));

						toast.error(`Failed to ${isRegeneration ? 'regenerate' : 'generate'} summary`, {
							description: errorMessage.includes('Connection refused')
								? 'Could not connect to LLM service. Please ensure Ollama or your configured LLM provider is running.'
								: errorMessage,
						});

						if (isModelRequiredError && onOpenModelSettings) {
							onOpenModelSettings();
						}

						await Analytics.trackSummaryGenerationCompleted(
							modelConfig.provider,
							modelConfig.model,
							false,
							undefined,
							errorMessage,
						);
						return;
					}

					if (pollingResult.status === 'completed' && pollingResult.data) {
						const data = pollingResult.data;
						const meetingName = data.MeetingName ?? pollingResult.meetingName;
						if (typeof meetingName === 'string' && meetingName) {
							updateMeetingTitle(meetingName);
						}

						if (data.markdown) {
							setAiSummary({ markdown: data.markdown } as unknown as Summary);
							summaryStatus = 'completed';
							toast.success('Summary generated successfully!', {
								description: 'Your meeting summary is ready',
								duration: 4000,
							});
							if (typeof meetingName === 'string' && meetingName && onMeetingUpdated) {
								await onMeetingUpdated();
							}
							await Analytics.trackSummaryGenerationCompleted(
								modelConfig.provider,
								modelConfig.model,
								true,
							);
							return;
						}

						// Legacy format handling.
						const summaryEntries = Object.entries(data).filter(([key]) => key !== 'MeetingName');
						const allEmpty = summaryEntries.every(([, section]) => {
							const blocks = (section as { blocks?: unknown[] })?.blocks;
							return !blocks || blocks.length === 0;
						});

						if (allEmpty) {
							summaryError = 'Summary generation completed but returned empty content.';
							summaryStatus = 'error';
							await Analytics.trackSummaryGenerationCompleted(
								modelConfig.provider,
								modelConfig.model,
								false,
								undefined,
								'Empty summary generated',
							);
							return;
						}

						const { MeetingName: _meetingName, _section_order, ...summaryData } = data;
						void _meetingName;
						const formattedSummary: Summary = {};
						const sectionKeys = _section_order ?? Object.keys(summaryData);

						for (const key of sectionKeys) {
							try {
								const section = (summaryData as Record<string, unknown>)[key];
								if (
									section &&
									typeof section === 'object' &&
									'title' in section &&
									'blocks' in section
								) {
									const typedSection = section as {
										title?: string;
										blocks?: Array<{ content?: string; [key: string]: unknown }>;
									};
									if (Array.isArray(typedSection.blocks)) {
										formattedSummary[key] = {
											title: typedSection.title || key,
											blocks: typedSection.blocks.map((block) => ({
												id: typeof block.id === 'string' ? block.id : '',
												type: typeof block.type === 'string' ? block.type : 'paragraph',
												color: 'default',
												content: block?.content?.trim() || '',
											})),
										};
									} else {
										formattedSummary[key] = { title: typedSection.title || key, blocks: [] };
									}
								}
							} catch (error) {
								console.warn(`Error processing section ${key}:`, error);
							}
						}

						setAiSummary(formattedSummary);
						summaryStatus = 'completed';
						toast.success('Summary generated successfully!', {
							description: 'Your meeting summary is ready',
							duration: 4000,
						});
						await Analytics.trackSummaryGenerationCompleted(
							modelConfig.provider,
							modelConfig.model,
							true,
						);
						if (typeof meetingName === 'string' && meetingName && onMeetingUpdated) {
							await onMeetingUpdated();
						}
					}
				},
			);
		} catch (error) {
			teardownPhaseListener();
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			summaryError = errorMessage;
			summaryStatus = 'error';
			toast.error(`Failed to ${isRegeneration ? 'regenerate' : 'generate'} summary`, {
				description: errorMessage,
			});
			await Analytics.trackSummaryGenerationCompleted(
				modelConfig.provider,
				modelConfig.model,
				false,
				undefined,
				errorMessage,
			);
		}
	};

	const fetchAllTranscripts = async (meetingId: string): Promise<Transcript[]> => {
		try {
			const firstPage = (await invoke('api_get_meeting_transcripts', {
				meetingId,
				limit: 1,
				offset: 0,
			})) as PaginatedTranscripts;

			if (firstPage.total_count === 0) return [];

			const allData = (await invoke('api_get_meeting_transcripts', {
				meetingId,
				limit: firstPage.total_count,
				offset: 0,
			})) as PaginatedTranscripts;
			return allData.transcripts;
		} catch (error) {
			console.error('Error fetching all transcripts:', error);
			toast.error('Failed to fetch transcripts for summary generation');
			return [];
		}
	};

	const validateOllamaModels = async (modelConfig: ModelConfig): Promise<boolean> => {
		try {
			const endpoint = modelConfig.ollamaEndpoint || null;
			const models = (await invoke('get_ollama_models', { endpoint })) as unknown[];
			if (!models || models.length === 0) {
				toast.error('No Ollama models found. Please download gemma3:1b from Model Settings.', {
					duration: 5000,
				});
				return false;
			}
			return true;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (isOllamaNotInstalledError(errorMessage)) {
				toast.error('Ollama is not installed', {
					description: 'Please download and install Ollama to use local models.',
					duration: 7000,
					action: {
						label: 'Download',
						onClick: () =>
							invoke('open_external_url', { url: 'https://ollama.com/download' }).catch(() => {}),
					},
				});
			} else {
				toast.error(
					'Failed to check Ollama models. Please ensure Ollama is running and download a model from Settings.',
					{ duration: 5000 },
				);
			}
			return false;
		}
	};

	const validateBuiltInAIModel = async (modelConfig: ModelConfig): Promise<boolean> => {
		try {
			const selectedModel = modelConfig.model;
			if (!selectedModel) {
				toast.error('No built-in AI model selected', {
					description: 'Please select a model in settings',
					duration: 5000,
				});
				onOpenModelSettings?.();
				return false;
			}

			const isReady = await invoke<boolean>('builtin_ai_is_model_ready', {
				modelName: selectedModel,
				refresh: true,
			});

			if (isReady) return true;

			const modelInfo = await invoke<BuiltInModelInfo | null>('builtin_ai_get_model_info', {
				modelName: selectedModel,
			});

			if (modelInfo) {
				const status = modelInfo.status;
				if (status.type === 'downloading') {
					toast.info('Model download in progress', {
						description: `${selectedModel} is downloading (${status.progress}%). Please wait until download completes.`,
						duration: 5000,
					});
					return false;
				}
				if (status.type === 'not_downloaded') {
					toast.error('Built-in AI model not downloaded', {
						description: `${selectedModel} needs to be downloaded. Please download it in model settings.`,
						duration: 7000,
					});
					onOpenModelSettings?.();
					return false;
				}
				if (status.type === 'corrupted' || status.type === 'error') {
					const errorDesc =
						status.type === 'error'
							? status.Error || 'The model file has an error'
							: 'The model file is corrupted';
					toast.error('Built-in AI model not available', {
						description: `${errorDesc}. Please check model settings.`,
						duration: 7000,
					});
					onOpenModelSettings?.();
					return false;
				}
			}

			toast.error('Built-in AI model not ready', {
				description: 'Please ensure the model is downloaded in settings',
				duration: 5000,
			});
			onOpenModelSettings?.();
			return false;
		} catch (error) {
			console.error('Error validating built-in AI model:', error);
			toast.error('Failed to validate built-in AI model', {
				description: error instanceof Error ? error.message : String(error),
				duration: 5000,
			});
			return false;
		}
	};

	function formatTime(seconds: number | undefined, fallback: string): string {
		if (seconds === undefined) return fallback;
		return formatRecordingTimestamp(seconds);
	}

	const handleGenerateSummary = async (customPrompt = ''): Promise<void> => {
		if (isGenerating()) return;
		if (getIsModelConfigLoading()) {
			toast.info('Loading model configuration, please wait...');
			return;
		}

		const meeting = getMeeting();
		const modelConfig = getModelConfig();

		const fullTranscript = await buildFullTranscript(meeting.id);
		if (!fullTranscript) {
			toast.error('No transcripts available for summary');
			return;
		}

		if (modelConfig.provider === 'ollama') {
			if (!(await validateOllamaModels(modelConfig))) return;
		}

		if (modelConfig.provider === 'builtin-ai') {
			if (!(await validateBuiltInAIModel(modelConfig))) return;
		}

		lastCustomPrompt = customPrompt;
		await processSummary({
			transcriptText: fullTranscript,
			customPrompt: buildGenerationContext(
				[customPrompt, TIMESTAMP_HINT].filter((s) => s.trim()).join('\n\n'),
			),
		});
	};

	const handleRegenerateSummary = async (): Promise<void> => {
		if (isGenerating()) return;
		const meeting = getMeeting();
		// After a remount `originalTranscript` is empty; rebuild from the meeting
		// instead of silently no-opping the Regenerate button.
		const transcript = originalTranscript.trim() || (await buildFullTranscript(meeting.id));
		if (!transcript.trim()) {
			toast.error('No transcript available to regenerate');
			return;
		}
		await processSummary({
			transcriptText: transcript,
			isRegeneration: true,
			// Reuse the last custom prompt + timestamp hint so regenerate keeps the
			// user's steering instead of dropping it.
			customPrompt: buildGenerationContext(
				[lastCustomPrompt, TIMESTAMP_HINT].filter((s) => s.trim()).join('\n\n'),
			),
		});
	};

	const handleStopGeneration = async (): Promise<void> => {
		const meeting = getMeeting();
		try {
			await invoke('api_cancel_summary', { meetingId: meeting.id });
		} catch (error) {
			console.error('Failed to cancel summary generation:', error);
		}

		sidebar.stopSummaryPolling(meeting.id);
		summaryStatus = 'idle';
		summaryError = null;

		toast.info('Summary generation stopped', {
			description: 'You can generate a new summary anytime',
			duration: 3000,
		});
	};

	return {
		get summaryStatus() {
			return summaryStatus;
		},
		get summaryError() {
			return summaryError;
		},
		handleGenerateSummary,
		handleRegenerateSummary,
		handleStopGeneration,
	};
}
