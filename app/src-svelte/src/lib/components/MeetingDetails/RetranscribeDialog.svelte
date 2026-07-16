<script lang="ts">
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { invoke } from '@tauri-apps/api/core';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import XIcon from '@lucide/svelte/icons/x';

	import { LANGUAGES } from '$lib/constants/languages';
	import { config } from '$lib/stores/config.svelte';
	import {
		useTranscriptionModels,
		type ModelOption,
	} from '$lib/hooks/use-transcription-models.svelte';
	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import { backgroundTasks } from '$lib/stores/background-tasks.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Progress } from '$lib/components/ui/progress';
	import * as Select from '$lib/components/ui/select';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		meetingId: string;
		meetingFolderPath: string | null;
		/** Called when the transcript changed outside the run flow (undo/restore). */
		onComplete?: () => void;
		/**
		 * Called once a run has actually started, with the user's follow-up
		 * choices. The owner observes completion via the global
		 * `retranscription-complete` event (the dialog can be backgrounded
		 * mid-run, so its own lifecycle cannot carry the completion).
		 */
		onStarted?: (options: { regenerateSummary: boolean }) => void;
		/** Whether the meeting already has a summary: sets the checkbox default
		 *  and whether it reads "Regenerate" or "Generate". */
		hasExistingSummary?: boolean;
	}

	let {
		open = $bindable(),
		onOpenChange,
		meetingId,
		meetingFolderPath,
		onComplete,
		onStarted,
		hasExistingSummary = false,
	}: Props = $props();

	interface RetranscriptionProgress {
		meeting_id: string;
		stage: string;
		progress_percentage: number;
		message: string;
	}

	interface RetranscriptionResult {
		meeting_id: string;
		segments_count: number;
		duration_seconds: number;
		language: string | null;
	}

	interface RetranscriptionError {
		meeting_id: string;
		error: string;
	}

	async function undoRetranscription(): Promise<void> {
		const restored = await invoke<boolean>('api_restore_latest_transcript_revision', {
			meetingId,
		});
		if (restored) {
			toast.success('Previous transcript restored');
			onComplete?.();
		}
	}

	let isProcessing = $state(false);
	let progress = $state<RetranscriptionProgress | null>(null);
	let error = $state<string | null>(null);
	let selectedLang = $state(config.selectedLanguage || 'auto');
	let regenerateSummary = $state(false);

	const models = useTranscriptionModels(() => config.transcriptModelConfig);

	const selectedModelDetails = $derived.by((): ModelOption | undefined => {
		const key = models.selectedModelKey;
		if (!key) return undefined;
		const colonIndex = key.indexOf(':');
		if (colonIndex === -1) return undefined;
		const provider = key.slice(0, colonIndex);
		const name = key.slice(colonIndex + 1);
		return models.availableModels.find((m) => m.provider === provider && m.name === name);
	});

	let wasOpen = false;
	// Reset state only on a closed→open transition.
	$effect(() => {
		if (open && !wasOpen) {
			models.resetSelection();
			isProcessing = false;
			progress = null;
			error = null;
			selectedLang = config.selectedLanguage || 'auto';
			regenerateSummary = hasExistingSummary;
			void models.fetchModels();
		}
		wasOpen = open;
	});

	// Listen for retranscription events while open.
	$effect(() => {
		if (!open) return;

		const unlisteners: UnlistenFn[] = [];
		let cleanedUp = false;

		const setup = async (): Promise<void> => {
			const unlistenProgress = await listen<RetranscriptionProgress>(
				'retranscription-progress',
				(event) => {
					if (event.payload.meeting_id === meetingId) {
						progress = event.payload;
					}
				},
			);
			if (cleanedUp) {
				unlistenProgress();
				return;
			}
			unlisteners.push(unlistenProgress);

			const unlistenComplete = await listen<RetranscriptionResult>(
				'retranscription-complete',
				async (event) => {
					if (event.payload.meeting_id === meetingId) {
						await Analytics.track('enhance_transcript_completed', {
							success: 'true',
							duration_seconds: event.payload.duration_seconds.toString(),
							segments_count: event.payload.segments_count.toString(),
						});
						isProcessing = false;
						toast.success(
							`Retranscription complete! ${event.payload.segments_count} segments created.`,
							{
								duration: 10_000,
								action: { label: 'Undo', onClick: () => void undoRetranscription() },
							},
						);
						// Refetch/summary chaining runs in the owner via the global
						// completion event; the dialog only closes itself.
						onOpenChange(false);
					}
				},
			);
			if (cleanedUp) {
				unlistenComplete();
				unlisteners.forEach((u) => u());
				return;
			}
			unlisteners.push(unlistenComplete);

			const unlistenError = await listen<RetranscriptionError>(
				'retranscription-error',
				async (event) => {
					if (event.payload.meeting_id === meetingId) {
						await Analytics.trackError('enhance_transcript_failed', event.payload.error);
						isProcessing = false;
						error = event.payload.error;
					}
				},
			);
			if (cleanedUp) {
				unlistenError();
				unlisteners.forEach((u) => u());
				return;
			}
			unlisteners.push(unlistenError);
		};

		void setup();

		return () => {
			cleanedUp = true;
			unlisteners.forEach((u) => u());
		};
	});

	async function handleStartRetranscription(): Promise<void> {
		if (!meetingFolderPath) {
			error = 'Meeting folder path not available';
			return;
		}

		isProcessing = true;
		error = null;
		progress = null;

		try {
			const languageToSend = selectedLang === 'auto' ? null : selectedLang;
			await Analytics.track('enhance_transcript_started', {
				language: selectedLang === 'auto' ? 'auto' : selectedLang,
				model_provider: selectedModelDetails?.provider || '',
				model_name: selectedModelDetails?.name || '',
			});

			backgroundTasks.begin('retranscription', meetingId, 'Re-transcribing meeting');
			await invoke('start_retranscription_command', {
				meetingId,
				meetingFolderPath,
				language: languageToSend,
				model: selectedModelDetails?.name || null,
				provider:
					selectedModelDetails?.provider === 'parakeet'
						? 'parakeet'
						: selectedModelDetails?.provider === 'automatic'
							? 'automatic'
							: null,
			});
			onStarted?.({ regenerateSummary });
		} catch (err) {
			isProcessing = false;
			const errorMsg =
				typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
			error = errorMsg;
			await Analytics.trackError('enhance_transcript_failed', errorMsg);
		}
	}

	async function handleCancel(): Promise<void> {
		if (isProcessing) {
			try {
				await invoke('cancel_retranscription_command');
				isProcessing = false;
				progress = null;
				toast.info('Retranscription cancelled');
			} catch (err) {
				console.error('Failed to cancel retranscription:', err);
			}
		}
		onOpenChange(false);
	}

	function handleOpenChange(newOpen: boolean): void {
		// Prevent closing during processing.
		if (!newOpen && isProcessing) return;
		onOpenChange(newOpen);
	}

	const selectedIsParakeet = $derived(selectedModelDetails?.provider === 'parakeet');

	const languageItems = LANGUAGES.map((lang) => ({ value: lang.code, label: lang.name }));
	const selectedLangLabel = $derived(
		languageItems.find((l) => l.value === selectedLang)?.label ?? 'Select language',
	);
	const modelItems = $derived(
		models.availableModels.map((model) => ({
			value: `${model.provider}:${model.name}`,
			label:
				model.provider === 'automatic'
					? model.displayName
					: `${model.displayName} (${Math.round(model.size_mb)} MB)`,
		})),
	);
	const selectedModelLabel = $derived(
		modelItems.find((m) => m.value === models.selectedModelKey)?.label ??
			(models.loadingModels ? 'Loading models...' : 'Select model'),
	);

	const dialogTitle = $derived(
		isProcessing ? 'Retranscribing...' : error ? 'Retranscription Failed' : 'Retranscribe Meeting',
	);
	const dialogDescription = $derived(
		isProcessing
			? progress?.message || 'Processing audio...'
			: error
				? 'An error occurred during retranscription'
				: 'Re-process the audio with different language settings',
	);
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-[450px]" showCloseButton={!isProcessing}>
		<Dialog.Title class="flex items-center gap-2 text-lg font-semibold">
			{#if isProcessing}
				<Loader2Icon class="size-5 animate-spin text-brand" />
			{:else if error}
				<AlertCircleIcon class="size-5 text-destructive" />
			{:else}
				<RefreshCwIcon class="size-5 text-brand" />
			{/if}
			{dialogTitle}
		</Dialog.Title>
		<Dialog.Description>{dialogDescription}</Dialog.Description>

		<div class="flex flex-col gap-4 py-4">
			{#if !isProcessing && !error}
				<div class="flex flex-col gap-3">
					<div class="flex items-center gap-2">
						<GlobeIcon class="size-4 text-muted-foreground" />
						<span class="text-sm font-medium">Language</span>
					</div>
					<Select.Root
						type="single"
						value={selectedLang}
						disabled={selectedIsParakeet}
						onValueChange={(v) => {
							if (v) selectedLang = v;
						}}
					>
						<Select.Trigger class="w-full">{selectedLangLabel}</Select.Trigger>
						<Select.Content>
							<Select.Group>
								{#each languageItems as item (item.value)}
									<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
								{/each}
							</Select.Group>
						</Select.Content>
					</Select.Root>
					<p class="text-xs text-muted-foreground">
						{selectedIsParakeet
							? 'Parakeet always auto-detects the language; this setting applies to Whisper models only'
							: 'Select a specific language to improve accuracy, or use auto-detect'}
					</p>
				</div>

				{#if models.availableModels.length > 0}
					<div class="flex flex-col gap-3">
						<div class="flex items-center gap-2">
							<CpuIcon class="size-4 text-muted-foreground" />
							<span class="text-sm font-medium">Model</span>
						</div>
						<Select.Root
							type="single"
							value={models.selectedModelKey ?? ''}
							disabled={models.loadingModels}
							onValueChange={(v) => {
								if (v) models.setSelectedModelKey(v);
							}}
						>
							<Select.Trigger class="w-full">{selectedModelLabel}</Select.Trigger>
							<Select.Content>
								<Select.Group>
									{#each modelItems as item (item.value)}
										<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
									{/each}
								</Select.Group>
							</Select.Content>
						</Select.Root>
						<p class="text-xs text-muted-foreground">
							{selectedIsParakeet
								? 'Parakeet is very fast across 25 European languages, but cannot translate to English or use your custom dictionary'
								: 'Choose a transcription model'}
						</p>
					</div>
				{/if}

				<div class="flex items-center gap-2">
					<Checkbox id="retranscribe-regen-summary" bind:checked={regenerateSummary} />
					<Label for="retranscribe-regen-summary" class="text-sm font-normal">
						{hasExistingSummary
							? 'Regenerate the AI summary when done'
							: 'Generate an AI summary when done'}
					</Label>
				</div>
			{/if}

			{#if isProcessing && progress}
				<div class="flex flex-col gap-2">
					<div>
						<Progress value={Math.min(progress.progress_percentage, 100)} />
						<div class="mt-1 flex justify-between text-xs text-muted-foreground">
							<span>{progress.stage}</span>
							<span>{Math.round(progress.progress_percentage)}%</span>
						</div>
					</div>
					<p class="text-center text-sm text-muted-foreground">{progress.message}</p>
				</div>
			{/if}

			{#if error}
				<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
					<p class="text-sm text-destructive">{error}</p>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			{#if !isProcessing && !error}
				<Button variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
				<Button variant="brand" disabled={!meetingFolderPath} onclick={handleStartRetranscription}>
					<RefreshCwIcon />
					Start Retranscription
				</Button>
			{/if}
			{#if isProcessing}
				<Button variant="outline" onclick={handleCancel}>
					<XIcon data-icon="inline-start" />
					Cancel
				</Button>
				<!-- Close the dialog without cancelling: the job keeps running and
				     stays visible in the sidebar's background tasks list. -->
				<Button variant="secondary" onclick={() => onOpenChange(false)}>Run in background</Button>
			{/if}
			{#if error}
				<Button variant="outline" onclick={() => onOpenChange(false)}>Close</Button>
				<Button
					variant="outline"
					onclick={() => {
						error = null;
						progress = null;
					}}
				>
					Try Again
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
