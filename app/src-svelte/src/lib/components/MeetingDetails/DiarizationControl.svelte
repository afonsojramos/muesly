<script lang="ts">
	import { Users } from '@lucide/svelte';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onMount } from 'svelte';

	import { commands } from '$lib/bindings';
	import { toast } from '$lib/toast';
	import Button from '$lib/ui/button.svelte';

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
				})
			);
			toast.info('Downloading speaker models…', { description: 'About 35 MB', duration: 4000 });
			const res = await commands.downloadDiarizationModels();
			if (res.status === 'error') throw new Error(res.error);
			ready = true;
			toast.info('Speaker models ready', { duration: 3000 });
		} catch (err) {
			toast.error('Speaker model download failed', {
				description: err instanceof Error ? err.message : 'Unknown error'
			});
		} finally {
			unlisteners.forEach((u) => u());
			downloading = false;
		}
	}

	async function identifySpeakers(): Promise<void> {
		if (diarizing) return;
		diarizing = true;
		try {
			const res = await commands.diarizeMeeting(meetingId);
			if (res.status === 'error') throw new Error(res.error);
			toast.info(`Identified speakers on ${res.data} segment${res.data === 1 ? '' : 's'}`, {
				duration: 3000
			});
			await onComplete?.();
		} catch (err) {
			toast.error('Speaker identification failed', {
				description: err instanceof Error ? err.message : 'Unknown error'
			});
		} finally {
			diarizing = false;
		}
	}
</script>

{#if ready !== null}
	{#if ready}
		<Button
			variant="outline"
			size="sm"
			class="border-accent/40 bg-accent/10 hover:bg-accent/20 @[28rem]:px-4"
			disabled={diarizing}
			aria-label="Identify speakers"
			tooltip="Identify who said what in this recording"
			onclick={identifySpeakers}
		>
			<Users class="@[28rem]:mr-2" />
			<span class="hidden @[22rem]:inline">{diarizing ? 'Identifying…' : 'Speakers'}</span>
		</Button>
	{:else}
		<Button
			variant="outline"
			size="sm"
			class="border-accent/40 bg-accent/10 hover:bg-accent/20 @[28rem]:px-4"
			disabled={downloading}
			aria-label="Download speaker models"
			tooltip="Download the speaker-identification models (~35 MB)"
			onclick={downloadModels}
		>
			<Users class="@[28rem]:mr-2" />
			<span class="hidden @[22rem]:inline">{downloading ? `${progress}%` : 'Speakers'}</span>
		</Button>
	{/if}
{/if}
