<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { AlertTriangle, Mic, RefreshCw, Speaker } from '@lucide/svelte';
	import Alert from '$lib/ui/alert.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';

	interface Props {
		hasMicrophone: boolean;
		hasSystemAudio: boolean;
		onRecheck: () => void;
		isRechecking?: boolean;
	}

	let { hasMicrophone, hasSystemAudio, onRecheck, isRechecking = false }: Props = $props();

	const platform = usePlatform();
	const isMacOS = $derived(platform.isMac);

	const title = $derived(
		!hasMicrophone && !hasSystemAudio
			? 'Permissions Required'
			: !hasMicrophone
				? 'Microphone Permission Required'
				: 'System Audio Permission Required'
	);

	async function openSettings(pane: 'Privacy_Microphone' | 'Privacy_ScreenCapture'): Promise<void> {
		if (!isMacOS) return;
		try {
			await invoke('open_system_settings', { preferencePane: pane });
		} catch (error) {
			console.error('Failed to open settings:', error);
		}
	}
</script>

{#if !platform.isLinux && !(hasMicrophone && hasSystemAudio)}
	<div class="mb-4 max-w-md space-y-3">
		<Alert variant="warning">
			{#snippet icon()}<AlertTriangle class="size-5" />{/snippet}
			{#snippet title()}
				<span class="flex items-center gap-2">
					{#if !hasMicrophone}<Mic class="size-4" />{/if}
					{#if !hasSystemAudio}<Speaker class="size-4" />{/if}
					{title}
				</span>
			{/snippet}

			<div class="mb-2 mt-4 flex flex-wrap gap-2">
				{#if isMacOS && !hasMicrophone}
					<button
						onclick={() => openSettings('Privacy_Microphone')}
						class="inline-flex items-center gap-2 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700"
					>
						<Mic class="size-4" /> Open Microphone Settings
					</button>
				{/if}
				{#if isMacOS && !hasSystemAudio}
					<button
						onclick={() => openSettings('Privacy_ScreenCapture')}
						class="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:opacity-90"
					>
						<Speaker class="size-4" /> Open Screen Recording Settings
					</button>
				{/if}
				<button
					onclick={onRecheck}
					disabled={isRechecking}
					class="inline-flex items-center gap-2 rounded-md bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-200 disabled:opacity-50"
				>
					<RefreshCw class={`size-4 ${isRechecking ? 'animate-spin' : ''}`} /> Recheck
				</button>
			</div>

			{#if !hasMicrophone}
				<p class="mb-3">
					muesly needs microphone access to record meetings. No microphone devices were detected.
				</p>
			{/if}
			{#if !hasSystemAudio}
				<p class="mb-3">
					{hasMicrophone
						? "System audio capture isn't available. You can still record with your microphone, but computer audio won't be captured."
						: 'System audio capture is also not available.'}
				</p>
				{#if isMacOS}
					<ul class="ml-2 list-inside list-disc space-y-1 text-sm">
						<li>Install a virtual audio device (e.g. BlackHole 2ch)</li>
						<li>Grant Screen Recording permission to muesly</li>
						<li>Configure routing in Audio MIDI Setup</li>
					</ul>
				{/if}
			{/if}
		</Alert>
	</div>
{/if}
