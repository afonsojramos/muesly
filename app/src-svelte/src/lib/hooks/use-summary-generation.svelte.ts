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

import { invoke } from '@tauri-apps/api/core';

import type { Summary, Transcript } from '$lib/types';
import type { ModelConfig } from '$lib/services/config';
import type { BuiltInModelInfo } from '$lib/ai/builtin-ai';
import { Analytics } from '$lib/analytics';
import { sidebar } from '$lib/stores/sidebar.svelte';
import { toast } from '$lib/toast';
import { isOllamaNotInstalledError } from '$lib/utils';

export type SummaryStatus =
	| 'idle'
	| 'processing'
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
			blocks.push(`The user's own notes taken during the meeting:\n${notesMarkdown}`);
		}
		if (customPrompt.trim()) {
			blocks.push(customPrompt.trim());
		}
		return blocks.join('\n\n');
	};

	let summaryStatus = $state<SummaryStatus>('idle');
	let summaryError = $state<string | null>(null);
	let originalTranscript = '';

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
		const total = Math.floor(seconds);
		const mins = Math.floor(total / 60);
		const secs = total % 60;
		return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
	}

	const handleGenerateSummary = async (customPrompt = ''): Promise<void> => {
		if (getIsModelConfigLoading()) {
			toast.info('Loading model configuration, please wait...');
			return;
		}

		const meeting = getMeeting();
		const modelConfig = getModelConfig();

		const allTranscripts = await fetchAllTranscripts(meeting.id);
		if (allTranscripts.length === 0) {
			toast.error('No transcripts available for summary');
			return;
		}

		if (modelConfig.provider === 'ollama') {
			if (!(await validateOllamaModels(modelConfig))) return;
		}

		if (modelConfig.provider === 'builtin-ai') {
			if (!(await validateBuiltInAIModel(modelConfig))) return;
		}

		const fullTranscript = allTranscripts
			.map((t) => {
				// Speaker attribution improves summary quality ("Me" = the user).
				const speaker = t.speaker === 'mic' ? 'Me: ' : t.speaker === 'system' ? 'Them: ' : '';
				return `${formatTime(t.audio_start_time, t.timestamp)} ${speaker}${t.text}`;
			})
			.join('\n');

		await processSummary({
			transcriptText: fullTranscript,
			customPrompt: buildGenerationContext(customPrompt),
		});
	};

	const handleRegenerateSummary = async (): Promise<void> => {
		if (!originalTranscript.trim()) {
			console.error('No original transcript available for regeneration');
			return;
		}
		await processSummary({
			transcriptText: originalTranscript,
			isRegeneration: true,
			customPrompt: buildGenerationContext(''),
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
