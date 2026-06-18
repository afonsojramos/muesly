<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { fly } from 'svelte/transition';
	import { Mic, Sparkles, Check, Loader2, Download, RotateCw } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import Button from '$lib/ui/button.svelte';
	import { toast } from '$lib/toast';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import OnboardingContainer from '../OnboardingContainer.svelte';

	const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8';

	type DownloadStatus = 'waiting' | 'downloading' | 'completed' | 'error';

	interface DownloadState {
		status: DownloadStatus;
		progress: number;
		downloadedMb: number;
		totalMb: number;
		speedMbps: number;
		error?: string;
	}

	const platform = usePlatform();
	let recommendedModel = $state<string>('gemma3:1b');

	let parakeetState = $state<DownloadState>({
		status: onboarding.parakeetDownloaded ? 'completed' : 'waiting',
		progress: onboarding.parakeetDownloaded ? 100 : 0,
		downloadedMb: 0,
		totalMb: 670,
		speedMbps: 0
	});

	let gemmaState = $state<DownloadState>({
		status: onboarding.summaryModelDownloaded ? 'completed' : 'waiting',
		progress: onboarding.summaryModelDownloaded ? 100 : 0,
		downloadedMb: 0,
		totalMb: 806,
		speedMbps: 0
	});

	let isCompleting = $state(false);
	let downloadStarted = false;
	let retrying = false;
	let retryingSummary = false;

	async function handleRetryDownload(): Promise<void> {
		if (retrying) return;
		retrying = true;

		parakeetState = {
			...parakeetState,
			status: 'waiting',
			error: undefined,
			progress: 0,
			downloadedMb: 0,
			speedMbps: 0
		};

		try {
			await invoke('parakeet_retry_download', { modelName: PARAKEET_MODEL });
		} catch (error) {
			console.error('[DownloadProgressStep] Retry failed:', error);
			parakeetState = {
				...parakeetState,
				status: 'error',
				error: error instanceof Error ? error.message : 'Retry failed'
			};
			toast.error('Download retry failed', {
				description: 'Please check your connection and try again.'
			});
		} finally {
			setTimeout(() => {
				retrying = false;
			}, 2000);
		}
	}

	async function handleRetrySummaryDownload(): Promise<void> {
		if (retryingSummary) return;
		retryingSummary = true;

		gemmaState = {
			...gemmaState,
			status: 'downloading',
			error: undefined,
			progress: 0,
			downloadedMb: 0,
			speedMbps: 0
		};

		try {
			await invoke('builtin_ai_download_model', {
				modelName: onboarding.selectedSummaryModel || recommendedModel
			});
		} catch (error) {
			console.error('[DownloadProgressStep] Summary retry failed:', error);
			gemmaState = {
				...gemmaState,
				status: 'error',
				error: error instanceof Error ? error.message : 'Retry failed'
			};
			toast.error('Summary model download retry failed', {
				description: 'Please check your connection and try again.'
			});
		} finally {
			setTimeout(() => {
				retryingSummary = false;
			}, 2000);
		}
	}

	async function startDownloads(): Promise<void> {
		if (onboarding.parakeetDownloaded && onboarding.summaryModelDownloaded) return;

		try {
			if (!onboarding.parakeetDownloaded) {
				parakeetState = { ...parakeetState, status: 'downloading' };
			}
			if (!onboarding.summaryModelDownloaded) {
				gemmaState = { ...gemmaState, status: 'downloading' };
			}
			await onboarding.startBackgroundDownloads(true);
		} catch (error) {
			console.error('Failed to start downloads:', error);
			if (!onboarding.parakeetDownloaded) {
				parakeetState = { ...parakeetState, status: 'error', error: String(error) };
			}
		}
	}

	async function handleContinue(): Promise<void> {
		// Verify actual model availability (catches state drift).
		try {
			await invoke('parakeet_init');
			const actuallyAvailable = await invoke<boolean>('parakeet_has_available_models');

			if (actuallyAvailable && !onboarding.parakeetDownloaded) {
				onboarding.setParakeetDownloaded(true);
				parakeetState = { ...parakeetState, status: 'completed', progress: 100 };
			} else if (!actuallyAvailable && parakeetState.status === 'error') {
				toast.error('Transcription engine required', {
					description: 'Please retry the download before continuing.'
				});
				return;
			}
		} catch (error) {
			console.warn('[DownloadProgressStep] Failed to verify model:', error);
		}

		const downloadsComplete =
			parakeetState.status === 'completed' && gemmaState.status === 'completed';

		if (!downloadsComplete) {
			toast.info('Downloads will continue in the background', {
				description:
					'You can start using the app. Recording will be available once speech recognition is ready.',
				duration: 5000
			});
		}

		if (platform.isMac) {
			onboarding.goNext();
		} else {
			isCompleting = true;
			try {
				await onboarding.completeOnboarding();
				await new Promise((resolve) => setTimeout(resolve, 100));
				if (typeof window !== 'undefined') window.location.reload();
			} catch (error) {
				console.error('Failed to complete onboarding:', error);
				toast.error('Failed to complete setup', { description: 'Please try again.' });
				isCompleting = false;
			}
		}
	}

	// Fetch recommended model + start downloads on mount.
	$effect(() => {
		let cancelled = false;

		invoke<string>('builtin_ai_get_recommended_model')
			.then((model) => {
				if (cancelled) return;
				recommendedModel = model;
				onboarding.setSelectedSummaryModel(model);
			})
			.catch((error) => {
				console.error('Failed to get recommended model:', error);
			});

		if (!downloadStarted) {
			downloadStarted = true;
			void startDownloads();
		}

		return () => {
			cancelled = true;
		};
	});

	// Download progress listeners (per-card status/error detail the store doesn't track).
	$effect(() => {
		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;

		(async () => {
			try {
				const unlistenProgress = await listen<{
					modelName: string;
					progress: number;
					downloaded_mb?: number;
					total_mb?: number;
					speed_mbps?: number;
					status?: string;
				}>('parakeet-model-download-progress', (event) => {
					const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } =
						event.payload;
					if (modelName !== PARAKEET_MODEL) return;
					parakeetState = {
						...parakeetState,
						status: status === 'completed' ? 'completed' : 'downloading',
						progress,
						downloadedMb: downloaded_mb ?? parakeetState.downloadedMb,
						totalMb: total_mb ?? parakeetState.totalMb,
						speedMbps: speed_mbps ?? parakeetState.speedMbps
					};
					if (status === 'completed' || progress >= 100) {
						onboarding.setParakeetDownloaded(true);
					}
				});
				if (cancelled) unlistenProgress();
				else unsubscribers.push(unlistenProgress);

				const unlistenComplete = await listen<{ modelName: string }>(
					'parakeet-model-download-complete',
					(event) => {
						if (event.payload.modelName !== PARAKEET_MODEL) return;
						parakeetState = { ...parakeetState, status: 'completed', progress: 100 };
						onboarding.setParakeetDownloaded(true);
					}
				);
				if (cancelled) unlistenComplete();
				else unsubscribers.push(unlistenComplete);

				const unlistenError = await listen<{ modelName: string; error: string }>(
					'parakeet-model-download-error',
					(event) => {
						if (event.payload.modelName !== PARAKEET_MODEL) return;
						parakeetState = { ...parakeetState, status: 'error', error: event.payload.error };
					}
				);
				if (cancelled) unlistenError();
				else unsubscribers.push(unlistenError);

				const unlistenGemma = await listen<{
					model: string;
					progress: number;
					downloaded_mb?: number;
					total_mb?: number;
					speed_mbps?: number;
					status: string;
					error?: string;
				}>('builtin-ai-download-progress', (event) => {
					const { model, progress, downloaded_mb, total_mb, speed_mbps, status, error } =
						event.payload;
					if (
						model !== onboarding.selectedSummaryModel &&
						model !== 'gemma3:1b' &&
						model !== 'gemma3:4b'
					)
						return;
					gemmaState = {
						...gemmaState,
						status:
							status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'downloading',
						progress,
						downloadedMb: downloaded_mb ?? gemmaState.downloadedMb,
						totalMb: total_mb ?? gemmaState.totalMb,
						speedMbps: speed_mbps ?? gemmaState.speedMbps,
						error: status === 'error' ? error : undefined
					};
					if (status === 'completed' || progress >= 100) {
						onboarding.setSummaryModelDownloaded(true);
					}
				});
				if (cancelled) unlistenGemma();
				else unsubscribers.push(unlistenGemma);
			} catch (error) {
				console.error('[DownloadProgressStep] Failed to set up listeners:', error);
			}
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});

	const totalSteps = $derived(platform.isMac ? 4 : 3);
	const SUMMARY_MODEL_SIZES: Record<string, string> = {
		'qwen3.5:4b': '~2.6 GB',
		'qwen3.5:2b': '~1.2 GB',
		'gemma3:4b': '~2.5 GB',
		'gemma3:1b': '~1 GB'
	};
	const summaryModelSize = $derived(SUMMARY_MODEL_SIZES[recommendedModel] ?? '~1.2 GB');
</script>

{#snippet downloadCard(title: string, icon: Snippet, state: DownloadState, modelSize: string)}
	<div class="bg-card rounded-xl border border-border p-5">
		<div class="flex items-center justify-between mb-4">
			<div class="flex items-center gap-3">
				<div class="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
					{@render icon()}
				</div>
				<div>
					<h3 class="font-medium text-foreground">{title}</h3>
					<p class="text-sm text-muted-foreground">{modelSize}</p>
				</div>
			</div>
			<div>
				{#if state.status === 'waiting'}
					<span class="text-sm text-muted-foreground">Waiting...</span>
				{:else if state.status === 'downloading'}
					<Loader2 class="w-5 h-5 text-foreground animate-spin" />
				{:else if state.status === 'completed'}
					<div class="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
						<Check class="w-4 h-4 text-green-600" />
					</div>
				{:else if state.status === 'error'}
					<span class="text-sm text-destructive">Failed</span>
				{/if}
			</div>
		</div>

		<!-- Progress Bar -->
		{#if state.status === 'downloading' || state.status === 'completed'}
			<div class="space-y-2">
				<div class="w-full h-2 bg-secondary rounded-full overflow-hidden">
					<div
						class="h-full bg-primary rounded-full transition-all duration-300"
						style="width: {state.progress}%"
					></div>
				</div>
				<div class="flex items-center justify-between text-sm">
					<span class="text-muted-foreground">
						{state.downloadedMb.toFixed(1)} MB / {state.totalMb.toFixed(1)} MB
					</span>
					<div class="flex items-center gap-2">
						{#if state.speedMbps > 0}
							<span class="text-muted-foreground">{state.speedMbps.toFixed(1)} MB/s</span>
						{/if}
						<span class="font-semibold text-foreground">{Math.round(state.progress)}%</span>
					</div>
				</div>
			</div>
		{/if}

		{#if state.status === 'error' && state.error}
			<div class="mt-2 p-3 bg-destructive/5 border border-destructive/20 rounded-md">
				<p class="text-sm text-destructive font-medium">Download Error</p>
				<p class="text-xs text-destructive/80 mt-1">{state.error}</p>
				{#if title === 'Transcription Engine' || title === 'Summary Engine'}
					<button
						type="button"
						onclick={title === 'Transcription Engine'
							? handleRetryDownload
							: handleRetrySummaryDownload}
						class="mt-3 w-full h-9 px-4 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md transition-colors flex items-center justify-center gap-2"
					>
						<RotateCw class="w-4 h-4" />
						Try Again
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<OnboardingContainer
	title="Getting things ready"
	description="You can start using muesly after downloading the Transcription Engine."
	step={3}
	{totalSteps}
>
	<div class="flex flex-col items-center space-y-6">
		<!-- Download Cards -->
		<div class="w-full max-w-lg space-y-4">
			{@render downloadCard('Transcription Engine', micIcon, parakeetState, '~670 MB')}
			{@render downloadCard('Summary Engine', sparklesIcon, gemmaState, summaryModelSize)}
		</div>

		<!-- Info Message - Only show when Parakeet is downloaded -->
		{#if onboarding.parakeetDownloaded && !onboarding.summaryModelDownloaded}
			<div
				class="w-full max-w-lg bg-muted rounded-lg p-4 text-sm text-foreground"
				transition:fly={{ y: -10, duration: 300 }}
			>
				<div class="flex items-start gap-3">
					<Download class="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
					<div>
						<p class="font-medium">You can continue while this finishes</p>
						<p class="text-muted-foreground mt-1">Download will continue in the background.</p>
					</div>
				</div>
			</div>
		{/if}

		<!-- Continue Button -->
		<div class="w-full max-w-xs">
			<Button
				onclick={handleContinue}
				disabled={!onboarding.parakeetDownloaded || isCompleting}
				class="w-full h-11"
			>
				{#if isCompleting || !onboarding.parakeetDownloaded}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{:else}
					Continue
				{/if}
			</Button>
		</div>
	</div>
</OnboardingContainer>

{#snippet micIcon()}
	<Mic class="w-5 h-5 text-muted-foreground" />
{/snippet}

{#snippet sparklesIcon()}
	<Sparkles class="w-5 h-5 text-muted-foreground" />
{/snippet}
