<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { fly } from 'svelte/transition';
	import { Mic, Sparkles, Check, Loader2, Download, RotateCw } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { Progress } from '$lib/components/ui/progress';
	import { toast } from '$lib/toast';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import OnboardingContainer from '../OnboardingContainer.svelte';

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

	let whisperState = $state<DownloadState>({
		status: onboarding.whisperDownloaded ? 'completed' : 'waiting',
		progress: onboarding.whisperDownloaded ? 100 : 0,
		downloadedMb: 0,
		totalMb: 0,
		speedMbps: 0,
	});

	let gemmaState = $state<DownloadState>({
		status: onboarding.summaryModelDownloaded ? 'completed' : 'waiting',
		progress: onboarding.summaryModelDownloaded ? 100 : 0,
		downloadedMb: 0,
		totalMb: 806,
		speedMbps: 0,
	});

	let isCompleting = $state(false);
	let downloadStarted = false;
	let retrying = false;
	let retryingSummary = false;

	async function handleRetryDownload(): Promise<void> {
		if (retrying) return;
		retrying = true;

		whisperState = {
			...whisperState,
			status: 'waiting',
			error: undefined,
			progress: 0,
			downloadedMb: 0,
			speedMbps: 0,
		};

		try {
			await invoke('whisper_download_model', { modelName: onboarding.selectedWhisperModel });
		} catch (error) {
			console.error('[DownloadProgressStep] Retry failed:', error);
			whisperState = {
				...whisperState,
				status: 'error',
				error: error instanceof Error ? error.message : 'Retry failed',
			};
			toast.error('Download retry failed', {
				description: 'Please check your connection and try again.',
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
			speedMbps: 0,
		};

		try {
			await invoke('builtin_ai_download_model', {
				modelName: onboarding.selectedSummaryModel || recommendedModel,
			});
		} catch (error) {
			console.error('[DownloadProgressStep] Summary retry failed:', error);
			gemmaState = {
				...gemmaState,
				status: 'error',
				error: error instanceof Error ? error.message : 'Retry failed',
			};
			toast.error('Summary model download retry failed', {
				description: 'Please check your connection and try again.',
			});
		} finally {
			setTimeout(() => {
				retryingSummary = false;
			}, 2000);
		}
	}

	async function startDownloads(): Promise<void> {
		if (onboarding.whisperDownloaded && onboarding.summaryModelDownloaded) return;

		try {
			if (!onboarding.whisperDownloaded) {
				whisperState = { ...whisperState, status: 'downloading' };
			}
			if (!onboarding.summaryModelDownloaded) {
				gemmaState = { ...gemmaState, status: 'downloading' };
			}
			await onboarding.startBackgroundDownloads(true);
		} catch (error) {
			console.error('Failed to start downloads:', error);
			if (!onboarding.whisperDownloaded) {
				whisperState = { ...whisperState, status: 'error', error: String(error) };
			}
		}
	}

	async function handleContinue(): Promise<void> {
		// Verify actual model availability (catches state drift).
		try {
			await invoke('whisper_init');
			const actuallyAvailable = await invoke<boolean>('whisper_has_available_models');

			if (actuallyAvailable && !onboarding.whisperDownloaded) {
				onboarding.setWhisperDownloaded(true);
				whisperState = { ...whisperState, status: 'completed', progress: 100 };
			} else if (!actuallyAvailable && whisperState.status === 'error') {
				toast.error('Transcription engine required', {
					description: 'Please retry the download before continuing.',
				});
				return;
			}
		} catch (error) {
			console.warn('[DownloadProgressStep] Failed to verify model:', error);
		}

		const downloadsComplete =
			whisperState.status === 'completed' && gemmaState.status === 'completed';

		if (!downloadsComplete) {
			toast.info('Downloads will continue in the background', {
				description:
					'You can start using the app. Recording will be available once speech recognition is ready.',
				duration: 5000,
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
				}>('model-download-progress', (event) => {
					const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } =
						event.payload;
					if (modelName !== onboarding.selectedWhisperModel) return;
					whisperState = {
						...whisperState,
						status: status === 'completed' ? 'completed' : 'downloading',
						progress,
						downloadedMb: downloaded_mb ?? whisperState.downloadedMb,
						totalMb: total_mb ?? whisperState.totalMb,
						speedMbps: speed_mbps ?? whisperState.speedMbps,
					};
					if (status === 'completed' || progress >= 100) {
						onboarding.setWhisperDownloaded(true);
					}
				});
				if (cancelled) unlistenProgress();
				else unsubscribers.push(unlistenProgress);

				const unlistenComplete = await listen<{ modelName: string }>(
					'model-download-complete',
					(event) => {
						if (event.payload.modelName !== onboarding.selectedWhisperModel) return;
						whisperState = { ...whisperState, status: 'completed', progress: 100 };
						onboarding.setWhisperDownloaded(true);
					},
				);
				if (cancelled) unlistenComplete();
				else unsubscribers.push(unlistenComplete);

				const unlistenError = await listen<{ modelName: string; error: string }>(
					'model-download-error',
					(event) => {
						if (event.payload.modelName !== onboarding.selectedWhisperModel) return;
						whisperState = { ...whisperState, status: 'error', error: event.payload.error };
					},
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
						error: status === 'error' ? error : undefined,
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
		'gemma3:1b': '~1 GB',
	};
	const summaryModelSize = $derived(SUMMARY_MODEL_SIZES[recommendedModel] ?? '~1.2 GB');
</script>

{#snippet downloadCard(title: string, icon: Snippet, state: DownloadState, modelSize: string)}
	<Card.Root>
		<Card.Content>
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-3">
					<div class="flex size-10 items-center justify-center rounded-full bg-muted">
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
						<Loader2 class="size-5 text-foreground animate-spin" />
					{:else if state.status === 'completed'}
						<div class="flex size-6 items-center justify-center rounded-full bg-success/15">
							<Check class="size-4 text-success" />
						</div>
					{:else if state.status === 'error'}
						<span class="text-sm text-destructive">Failed</span>
					{/if}
				</div>
			</div>

			<!-- Progress Bar -->
			{#if state.status === 'downloading' || state.status === 'completed'}
				<div class="flex flex-col gap-2">
					<Progress value={Math.min(state.progress, 100)} class="h-2" />
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
						<Button
							onclick={title === 'Transcription Engine'
								? handleRetryDownload
								: handleRetrySummaryDownload}
							class="mt-3 w-full"
						>
							<RotateCw />
							Try Again
						</Button>
					{/if}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
{/snippet}

<OnboardingContainer
	title="Getting things ready"
	description="You can start using muesly after downloading the Transcription Engine."
	step={3}
	{totalSteps}
>
	<div class="flex flex-col items-center gap-6">
		<!-- Download Cards -->
		<div class="flex w-full max-w-lg flex-col gap-4">
			{@render downloadCard(
				'Whisper Transcription',
				micIcon,
				whisperState,
				onboarding.selectedWhisperModel,
			)}
			{@render downloadCard('Summary Engine', sparklesIcon, gemmaState, summaryModelSize)}
		</div>

		{#if onboarding.whisperDownloaded && !onboarding.summaryModelDownloaded}
			<div class="w-full max-w-lg" transition:fly={{ y: -10, duration: 300 }}>
				<Alert.Root class="bg-muted">
					<Download class="text-muted-foreground" />
					<Alert.Title>You can continue while this finishes</Alert.Title>
					<Alert.Description>Download will continue in the background.</Alert.Description>
				</Alert.Root>
			</div>
		{/if}

		<!-- Continue Button -->
		<div class="w-full max-w-xs">
			<Button
				onclick={handleContinue}
				disabled={!onboarding.whisperDownloaded || isCompleting}
				class="h-11 w-full"
			>
				{#if isCompleting || !onboarding.whisperDownloaded}
					<Loader2 class="animate-spin" />
				{:else}
					Continue
				{/if}
			</Button>
		</div>
	</div>
</OnboardingContainer>

{#snippet micIcon()}
	<Mic class="size-5 text-muted-foreground" />
{/snippet}

{#snippet sparklesIcon()}
	<Sparkles class="size-5 text-muted-foreground" />
{/snippet}
