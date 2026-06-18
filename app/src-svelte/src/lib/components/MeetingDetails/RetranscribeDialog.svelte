<script lang="ts">
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { invoke } from '@tauri-apps/api/core';
	import { AlertCircle, Cpu, Globe, Loader2, RefreshCw, X } from '@lucide/svelte';

	import { LANGUAGES } from '$lib/constants/languages';
	import { config } from '$lib/stores/config.svelte';
	import { useTranscriptionModels, type ModelOption } from '$lib/hooks/use-transcription-models.svelte';
	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import Button from '$lib/ui/button.svelte';
	import Dialog from '$lib/ui/dialog.svelte';
	import Select from '$lib/ui/select.svelte';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		meetingId: string;
		meetingFolderPath: string | null;
		onComplete?: () => void;
	}

	let { open = $bindable(), onOpenChange, meetingId, meetingFolderPath, onComplete }: Props = $props();

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

	let isProcessing = $state(false);
	let progress = $state<RetranscriptionProgress | null>(null);
	let error = $state<string | null>(null);
	let selectedLang = $state(config.selectedLanguage || 'auto');

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

	const isParakeetModel = $derived(selectedModelDetails?.provider === 'parakeet');

	$effect(() => {
		if (isParakeetModel && selectedLang !== 'auto') {
			selectedLang = 'auto';
		}
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
				}
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
							segments_count: event.payload.segments_count.toString()
						});
						isProcessing = false;
						toast.success(
							`Retranscription complete! ${event.payload.segments_count} segments created.`
						);
						onComplete?.();
						onOpenChange(false);
					}
				}
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
				}
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
			const languageToSend = isParakeetModel ? null : selectedLang === 'auto' ? null : selectedLang;
			await Analytics.track('enhance_transcript_started', {
				language: isParakeetModel ? 'auto' : selectedLang === 'auto' ? 'auto' : selectedLang,
				model_provider: selectedModelDetails?.provider || '',
				model_name: selectedModelDetails?.name || ''
			});

			await invoke('start_retranscription_command', {
				meetingId,
				meetingFolderPath,
				language: languageToSend,
				model: selectedModelDetails?.name || null,
				provider: selectedModelDetails?.provider || null
			});
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

	const languageItems = LANGUAGES.map((lang) => ({ value: lang.code, label: lang.name }));
	const modelItems = $derived(
		models.availableModels.map((model) => ({
			value: `${model.provider}:${model.name}`,
			label: `${model.displayName} (${Math.round(model.size_mb)} MB)`
		}))
	);

	const dialogTitle = $derived(
		isProcessing ? 'Retranscribing...' : error ? 'Retranscription Failed' : 'Retranscribe Meeting'
	);
	const dialogDescription = $derived(
		isProcessing
			? progress?.message || 'Processing audio...'
			: error
				? 'An error occurred during retranscription'
				: 'Re-process the audio with different language settings'
	);
</script>

<Dialog
	bind:open
	onOpenChange={handleOpenChange}
	class="sm:max-w-[450px]"
	showClose={!isProcessing}
>
	<div class="flex items-center gap-2 text-lg font-semibold">
		{#if isProcessing}
			<Loader2 class="size-5 animate-spin text-accent" />
		{:else if error}
			<AlertCircle class="size-5 text-destructive" />
		{:else}
			<RefreshCw class="size-5 text-accent" />
		{/if}
		{dialogTitle}
	</div>
	<p class="mt-1 text-sm text-muted-foreground">{dialogDescription}</p>

	<div class="space-y-4 py-4">
		{#if !isProcessing && !error}
			{#if !isParakeetModel}
				<div class="space-y-3">
					<div class="flex items-center gap-2">
						<Globe class="size-4 text-muted-foreground" />
						<span class="text-sm font-medium">Language</span>
					</div>
					<Select
						items={languageItems}
						value={[selectedLang]}
						placeholder="Select language"
						onValueChange={(v) => {
							if (v[0]) selectedLang = v[0];
						}}
					/>
					<p class="text-xs text-muted-foreground">
						Select a specific language to improve accuracy, or use auto-detect
					</p>
				</div>
			{:else}
				<div class="space-y-3">
					<div class="flex items-center gap-2">
						<Globe class="size-4 text-muted-foreground" />
						<span class="text-sm font-medium">Language</span>
					</div>
					<p class="text-xs text-muted-foreground">
						Language selection isn't supported for Parakeet. It always uses automatic detection.
					</p>
				</div>
			{/if}

			{#if models.availableModels.length > 0}
				<div class="space-y-3">
					<div class="flex items-center gap-2">
						<Cpu class="size-4 text-muted-foreground" />
						<span class="text-sm font-medium">Model</span>
					</div>
					<Select
						items={modelItems}
						value={models.selectedModelKey ? [models.selectedModelKey] : []}
						placeholder={models.loadingModels ? 'Loading models...' : 'Select model'}
						disabled={models.loadingModels}
						onValueChange={(v) => {
							if (v[0]) models.setSelectedModelKey(v[0]);
						}}
					/>
					<p class="text-xs text-muted-foreground">Choose a transcription model</p>
				</div>
			{/if}
		{/if}

		{#if isProcessing && progress}
			<div class="space-y-2">
				<div class="relative">
					<div class="h-3 w-full rounded-full bg-secondary">
						<div
							class="h-3 rounded-full bg-accent transition-all duration-300 ease-out"
							style={`width: ${Math.min(progress.progress_percentage, 100)}%`}
						></div>
					</div>
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

	<div class="mt-2 flex justify-end gap-2">
		{#if !isProcessing && !error}
			<Button variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
			<Button variant="accent" disabled={!meetingFolderPath} onclick={handleStartRetranscription}>
				<RefreshCw class="size-4" />
				Start Retranscription
			</Button>
		{/if}
		{#if isProcessing}
			<Button variant="outline" onclick={handleCancel}>
				<X class="size-4" />
				Cancel
			</Button>
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
	</div>
</Dialog>
