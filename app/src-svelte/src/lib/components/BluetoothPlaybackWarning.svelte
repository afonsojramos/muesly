<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Speaker, X } from '@lucide/svelte';
	import Alert from '$lib/ui/alert.svelte';

	interface AudioOutputInfo {
		device_name: string;
		is_bluetooth: boolean;
		sample_rate: number | null;
		device_type: string;
	}

	interface Props {
		checkInterval?: number;
		enabled?: boolean;
	}

	let { checkInterval = 5000, enabled = true }: Props = $props();

	let isBluetoothActive = $state(false);
	let deviceName = $state('');
	let isDismissed = $state(false);

	$effect(() => {
		if (!enabled) return;

		const checkAudioOutput = async () => {
			try {
				const info = await invoke<AudioOutputInfo>('get_active_audio_output');
				if (info.is_bluetooth) {
					isBluetoothActive = true;
					deviceName = info.device_name;
				} else {
					isBluetoothActive = false;
					isDismissed = false;
				}
			} catch (error) {
				console.error('Failed to check audio output device:', error);
				isBluetoothActive = false;
			}
		};

		void checkAudioOutput();
		const interval = setInterval(checkAudioOutput, checkInterval);
		return () => clearInterval(interval);
	});

	const show = $derived(enabled && isBluetoothActive && !isDismissed);
</script>

{#if show}
	<Alert variant="warning" class="mb-4">
		{#snippet icon()}<Speaker class="size-4" />{/snippet}
		{#snippet title()}Bluetooth Playback Detected{/snippet}
		<div class="flex w-full items-start justify-between">
			<div class="flex-1">
				You're using <strong>{deviceName}</strong> for playback. Recordings may sound distorted or
				sped up through Bluetooth devices; the recording itself is unaffected. For accurate
				review, use <strong>computer speakers</strong> or <strong>wired headphones</strong>.
			</div>
			<button
				onclick={() => (isDismissed = true)}
				class="ml-4 rounded p-1 hover:bg-amber-100"
				aria-label="Dismiss warning"
			>
				<X class="size-4" />
			</button>
		</div>
	</Alert>
{/if}
