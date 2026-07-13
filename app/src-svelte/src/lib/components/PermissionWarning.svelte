<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { AlertTriangle, Mic, RefreshCw, Speaker } from '@lucide/svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
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
				: 'System Audio Permission Required',
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
	<div class="mb-4 max-w-md">
		<Alert.Root class="border-warning/50 bg-warning/10 text-warning">
			<AlertTriangle />
			<Alert.Title>
				<span class="flex items-center gap-2">
					{#if !hasMicrophone}<Mic class="size-4" />{/if}
					{#if !hasSystemAudio}<Speaker class="size-4" />{/if}
					{title}
				</span>
			</Alert.Title>
			<Alert.Description class="text-warning/90">
				<div class="mb-2 mt-2 flex flex-wrap gap-2">
					{#if isMacOS && !hasMicrophone}
						<Button
							size="sm"
							onclick={() => openSettings('Privacy_Microphone')}
							class="bg-warning text-warning-foreground hover:bg-warning/90"
						>
							<Mic data-icon="inline-start" /> Open Microphone Settings
						</Button>
					{/if}
					{#if isMacOS && !hasSystemAudio}
						<Button
							size="sm"
							onclick={() => openSettings('Privacy_ScreenCapture')}
							class="bg-warning text-warning-foreground hover:bg-warning/90"
						>
							<Speaker /> Open Screen Recording Settings
						</Button>
					{/if}
					<Button variant="outline" size="sm" onclick={onRecheck} disabled={isRechecking}>
						<RefreshCw class={isRechecking ? 'animate-spin' : ''} data-icon="inline-start" /> Recheck
					</Button>
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
						<ul class="ml-2 flex list-inside list-disc flex-col gap-1 text-sm">
							<li>
								Open System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording
							</li>
							<li>Enable muesly (or your terminal when running in dev)</li>
							<li>Start the recording again after granting access</li>
						</ul>
					{/if}
				{/if}
			</Alert.Description>
		</Alert.Root>
	</div>
{/if}
