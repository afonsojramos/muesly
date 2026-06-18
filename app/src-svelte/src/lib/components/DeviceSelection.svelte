<script lang="ts" module>
	export interface AudioDevice {
		name: string;
		device_type: 'Input' | 'Output';
	}

	export interface SelectedDevices {
		micDevice: string | null;
		systemDevice: string | null;
	}
</script>

<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Mic, RefreshCw, Speaker } from '@lucide/svelte';
	import { onMount } from 'svelte';

	import { track } from '$lib/analytics-events';
	import { getDeviceMetadata } from '$lib/utils/device-metadata';
	import Label from '$lib/ui/label.svelte';
	import Select from '$lib/ui/select.svelte';
	import AudioBackendSelector from './AudioBackendSelector.svelte';

	interface Props {
		selectedDevices: SelectedDevices;
		onDeviceChange: (devices: SelectedDevices) => void;
		disabled?: boolean;
	}

	let { selectedDevices, onDeviceChange, disabled = false }: Props = $props();

	let devices = $state<AudioDevice[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let refreshing = $state(false);

	const inputDevices = $derived(devices.filter((d) => d.device_type === 'Input'));
	const outputDevices = $derived(devices.filter((d) => d.device_type === 'Output'));

	const micItems = $derived([
		{ value: 'default', label: 'Default Microphone' },
		...inputDevices.map((d) => ({ value: `${d.name} (${d.device_type.toLowerCase()})`, label: d.name }))
	]);
	const systemItems = $derived([
		{ value: 'default', label: 'Default System Audio' },
		...outputDevices.map((d) => ({
			value: `${d.name} (${d.device_type.toLowerCase()})`,
			label: d.name
		}))
	]);

	async function fetchDevices(): Promise<void> {
		try {
			error = null;
			devices = await invoke<AudioDevice[]>('get_audio_devices');
		} catch (err) {
			console.error('Failed to fetch audio devices:', err);
			error = 'Failed to load audio devices. Please check your system audio settings.';
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	onMount(() => {
		void fetchDevices();
	});

	async function handleRefresh(): Promise<void> {
		refreshing = true;
		await fetchDevices();
	}

	function handleMicDeviceChange(value: string[]): void {
		const deviceName = value[0] ?? 'default';
		onDeviceChange({
			...selectedDevices,
			micDevice: deviceName === 'default' ? null : deviceName
		});

		const metadata = getDeviceMetadata(deviceName);
		track('microphone_selected', {
			device_category: metadata.category,
			is_bluetooth: metadata.isBluetooth.toString(),
			has_system_audio: (!!selectedDevices.systemDevice).toString()
		}).catch((err) => console.error('Failed to track microphone selection:', err));
	}

	function handleSystemDeviceChange(value: string[]): void {
		const deviceName = value[0] ?? 'default';
		onDeviceChange({
			...selectedDevices,
			systemDevice: deviceName === 'default' ? null : deviceName
		});

		const metadata = getDeviceMetadata(deviceName);
		track('system_audio_selected', {
			device_category: metadata.category,
			is_bluetooth: metadata.isBluetooth.toString(),
			has_microphone: (!!selectedDevices.micDevice).toString()
		}).catch((err) => console.error('Failed to track system audio selection:', err));
	}
</script>

{#if loading}
	<div class="space-y-4 p-4">
		<div class="animate-pulse">
			<div class="mb-4 h-4 w-1/3 rounded bg-secondary"></div>
			<div class="mb-3 h-10 rounded bg-secondary"></div>
			<div class="h-10 rounded bg-secondary"></div>
		</div>
	</div>
{:else}
	<div class="space-y-4">
		<div class="flex items-center justify-between">
			<h4 class="text-sm font-medium">Audio Devices</h4>
			<button
				onclick={handleRefresh}
				disabled={refreshing || disabled}
				class="inline-flex size-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-50"
				aria-label="Refresh devices"
			>
				<RefreshCw class={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
			</button>
		</div>

		{#if error}
			<div class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
				{error}
			</div>
		{/if}

		<div class="space-y-3">
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<Mic class="size-4 text-muted-foreground" />
					<Label class="text-sm font-medium">Microphone</Label>
				</div>
				<Select
					items={micItems}
					value={[selectedDevices.micDevice ?? 'default']}
					placeholder="Select Microphone"
					{disabled}
					onValueChange={handleMicDeviceChange}
				/>
				{#if inputDevices.length === 0}
					<p class="text-xs text-muted-foreground">No microphone devices found</p>
				{/if}
			</div>

			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<Speaker class="size-4 text-muted-foreground" />
					<Label class="text-sm font-medium">System Audio</Label>
				</div>
				<Select
					items={systemItems}
					value={[selectedDevices.systemDevice ?? 'default']}
					placeholder="Select System Audio"
					{disabled}
					onValueChange={handleSystemDeviceChange}
				/>
				{#if outputDevices.length === 0}
					<p class="text-xs text-muted-foreground">No system audio devices found</p>
				{/if}

				{#if !disabled}
					<div class="border-t border-border pt-3">
						<AudioBackendSelector {disabled} />
					</div>
				{/if}
			</div>
		</div>

		<div class="space-y-1 text-xs text-muted-foreground">
			<p>• <strong>Microphone:</strong> Records your voice and ambient sound</p>
			<p>• <strong>System Audio:</strong> Records computer audio (music, calls, etc.)</p>
		</div>
	</div>
{/if}
