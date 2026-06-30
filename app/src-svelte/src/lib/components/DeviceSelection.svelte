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
	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Skeleton } from '$lib/components/ui/skeleton';
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

	const micValue = $derived(selectedDevices.micDevice ?? 'default');
	const systemValue = $derived(selectedDevices.systemDevice ?? 'default');
	const micLabel = $derived(
		micItems.find((i) => i.value === micValue)?.label ?? 'Select Microphone'
	);
	const systemLabel = $derived(
		systemItems.find((i) => i.value === systemValue)?.label ?? 'Select System Audio'
	);

	function handleMicDeviceChange(value: string | undefined): void {
		const deviceName = value ?? 'default';
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

	function handleSystemDeviceChange(value: string | undefined): void {
		const deviceName = value ?? 'default';
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
	<div class="flex flex-col gap-4 p-4">
		<Skeleton class="h-4 w-1/3" />
		<Skeleton class="h-10 w-full" />
		<Skeleton class="h-10 w-full" />
	</div>
{:else}
	<div class="flex flex-col gap-4">
		<div class="flex items-center justify-between">
			<h4 class="text-sm font-medium">Audio Devices</h4>
			<Button
				variant="ghost"
				size="icon"
				class="size-8"
				onclick={handleRefresh}
				disabled={refreshing || disabled}
				aria-label="Refresh devices"
			>
				<RefreshCw class={cn(refreshing && 'animate-spin')} />
			</Button>
		</div>

		{#if error}
			<div class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
				{error}
			</div>
		{/if}

		<div class="flex flex-col gap-3">
			<div class="flex flex-col gap-2">
				<div class="flex items-center gap-2">
					<Mic class="size-4 text-muted-foreground" />
					<Label class="text-sm font-medium">Microphone</Label>
				</div>
				<Select.Root
					type="single"
					value={micValue}
					{disabled}
					onValueChange={handleMicDeviceChange}
				>
					<Select.Trigger class="w-full">{micLabel}</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each micItems as item (item.value)}
								<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
				{#if inputDevices.length === 0}
					<p class="text-xs text-muted-foreground">No microphone devices found</p>
				{/if}
			</div>

			<div class="flex flex-col gap-2">
				<div class="flex items-center gap-2">
					<Speaker class="size-4 text-muted-foreground" />
					<Label class="text-sm font-medium">System Audio</Label>
				</div>
				<Select.Root
					type="single"
					value={systemValue}
					{disabled}
					onValueChange={handleSystemDeviceChange}
				>
					<Select.Trigger class="w-full">{systemLabel}</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each systemItems as item (item.value)}
								<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
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

		<div class="flex flex-col gap-1 text-xs text-muted-foreground">
			<p>• <strong>Microphone:</strong> Records your voice and ambient sound</p>
			<p>• <strong>System Audio:</strong> Records computer audio (music, calls, etc.)</p>
		</div>
	</div>
{/if}
