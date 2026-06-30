<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Speaker, X } from '@lucide/svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';

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
	<Alert.Root class="mb-4 border-warning/50 bg-warning/10 text-warning">
		<Speaker />
		<Alert.Title>Bluetooth Playback Detected</Alert.Title>
		<Alert.Description class="text-warning/90">
			You're using <strong>{deviceName}</strong> for playback. Recordings may sound distorted or
			sped up through Bluetooth devices; the recording itself is unaffected. For accurate review,
			use <strong>computer speakers</strong> or <strong>wired headphones</strong>.
		</Alert.Description>
		<Alert.Action>
			<Button
				variant="ghost"
				size="icon"
				class="size-6 text-warning hover:bg-warning/20 hover:text-warning"
				onclick={() => (isDismissed = true)}
				aria-label="Dismiss warning"
			>
				<X />
			</Button>
		</Alert.Action>
	</Alert.Root>
{/if}
