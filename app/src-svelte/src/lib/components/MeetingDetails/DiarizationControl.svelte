<script lang="ts">
	import UsersIcon from '@lucide/svelte/icons/users';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onMount } from 'svelte';

	import { commands } from '$lib/bindings';
	import { toast } from '$lib/toast';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		meetingId: string;
		/** Called after speakers are identified, so the transcript can reload. */
		onComplete?: () => void | Promise<void>;
	}

	let { meetingId, onComplete }: Props = $props();

	// null while we haven't checked yet, then whether both models are on disk.
	let ready = $state<boolean | null>(null);
	let downloading = $state(false);
	let progress = $state(0);
	let diarizing = $state(false);

	onMount(() => {
		void refreshReady();
	});

	async function refreshReady(): Promise<void> {
		const res = await commands.diarizationModelsReady();
		ready = res.status === 'ok' ? res.data : false;
	}

	async function downloadModels(): Promise<void> {
		if (downloading) return;
		downloading = true;
		progress = 0;
		const unlisteners: UnlistenFn[] = [];
		try {
			unlisteners.push(
				await listen<{ progress?: number }>('diarization-model-download-progress', (e) => {
					if (typeof e.payload?.progress === 'number') progress = Math.round(e.payload.progress);
				}),
			);
			toast.info('Downloading speaker models…', { description: 'About 35 MB', duration: 4000 });
			const res = await commands.downloadDiarizationModels();
			if (res.status === 'error') throw new Error(res.error);
			ready = true;
			toast.info('Speaker models ready', { duration: 3000 });
		} catch (err) {
			toast.error('Speaker model download failed', {
				description: err instanceof Error ? err.message : 'Unknown error',
			});
		} finally {
			unlisteners.forEach((u) => u());
			downloading = false;
		}
	}

	let confirmOpen = $state(false);

	// Re-diarization clears assigned names (cluster numbering isn't stable across
	// runs), so when names exist the run needs an explicit confirmation first.
	async function identifySpeakers(): Promise<void> {
		if (diarizing) return;
		const speakers = await commands.getMeetingSpeakers(meetingId);
		const hasAssignedNames =
			speakers.status === 'ok' && speakers.data.speakers.some((s) => s.name != null);
		if (hasAssignedNames) {
			confirmOpen = true;
			return;
		}
		await runDiarization();
	}

	async function runDiarization(): Promise<void> {
		if (diarizing) return;
		diarizing = true;
		try {
			const res = await commands.diarizeMeeting(meetingId);
			if (res.status === 'error') throw new Error(res.error);
			toast.info(`Identified speakers on ${res.data} segment${res.data === 1 ? '' : 's'}`, {
				duration: 3000,
			});
			await onComplete?.();
		} catch (err) {
			toast.error('Speaker identification failed', {
				description: err instanceof Error ? err.message : 'Unknown error',
			});
		} finally {
			diarizing = false;
		}
	}
</script>

{#if ready !== null}
	{#if ready}
		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="outline"
							size="sm"
							class="border-brand/40 bg-brand/10 hover:bg-brand/20 @[34rem]:px-4"
							disabled={diarizing}
							aria-label="Identify speakers"
							onclick={identifySpeakers}
						>
							<UsersIcon data-icon="inline-start" />
							<span class="hidden @[30rem]:inline">{diarizing ? 'Identifying…' : 'Speakers'}</span>
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Identify who said what in this recording</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{:else}
		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="outline"
							size="sm"
							class="border-brand/40 bg-brand/10 hover:bg-brand/20 @[34rem]:px-4"
							disabled={downloading}
							aria-label="Download speaker models"
							onclick={downloadModels}
						>
							<UsersIcon data-icon="inline-start" />
							<span class="hidden @[30rem]:inline">{downloading ? `${progress}%` : 'Speakers'}</span
							>
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Download the speaker-identification models (~35 MB)</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}
{/if}

<Dialog.Root bind:open={confirmOpen}>
	<Dialog.Content class="sm:max-w-[420px]">
		<Dialog.Title>Re-identify speakers?</Dialog.Title>
		<Dialog.Description>
			Speaker groups are rebuilt from scratch, so the names you assigned to speakers in this meeting
			will be cleared.
		</Dialog.Description>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirmOpen = false)}>Cancel</Button>
			<Button
				variant="brand"
				onclick={() => {
					confirmOpen = false;
					void runDiarization();
				}}
			>
				Re-identify
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
