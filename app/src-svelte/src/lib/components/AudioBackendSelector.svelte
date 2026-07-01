<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Info } from '@lucide/svelte';
	import * as Alert from '$lib/components/ui/alert';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Badge } from '$lib/components/ui/badge';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { cn } from '$lib/utils';

	export interface BackendInfo {
		id: string;
		name: string;
		description: string;
	}

	interface Props {
		currentBackend?: string;
		onBackendChange?: (backend: string) => void;
		disabled?: boolean;
	}

	let { currentBackend: propBackend, onBackendChange, disabled = false }: Props = $props();

	let backends = $state<BackendInfo[]>([]);
	let currentBackend = $state<string>('coreaudio');
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		(async () => {
			try {
				loading = true;
				error = null;
				backends = await invoke<BackendInfo[]>('get_audio_backend_info');
				currentBackend = propBackend ?? (await invoke<string>('get_current_audio_backend'));
			} catch (err) {
				console.error('Failed to load audio backends:', err);
				error = 'Failed to load backend options';
			} finally {
				loading = false;
			}
		})();
	});

	async function handleBackendChange(backendId: string): Promise<void> {
		try {
			error = null;
			await invoke('set_audio_backend', { backend: backendId });
			currentBackend = backendId;
			onBackendChange?.(backendId);
		} catch (err) {
			console.error('Failed to set audio backend:', err);
			error = 'Failed to change backend. Please try again.';
		}
	}
</script>

{#if loading}
	<div class="flex flex-col gap-2">
		<Skeleton class="h-4 w-32" />
		<Skeleton class="h-10 w-full" />
	</div>
{:else if backends.length > 1}
	<div class="flex flex-col gap-2">
		<div class="flex items-center gap-2">
			<span class="text-sm font-medium">System Audio Backend</span>
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger
						class="text-muted-foreground transition-colors hover:text-foreground"
						aria-label="Backend info"
					>
						<Info class="size-4" />
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-64 flex-col items-start gap-1 p-3 text-left">
						<p class="font-semibold">Audio Capture Methods:</p>
						<ul class="flex flex-col gap-1">
							{#each backends as backend (backend.id)}
								<li><span class="font-medium">{backend.name}:</span> {backend.description}</li>
							{/each}
						</ul>
						<p class="text-background/70">
							Try different backends to find which works best for your system.
						</p>
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		</div>

		{#if error}
			<Alert.Root variant="destructive" class="py-2">
				<Alert.Description class="text-xs">{error}</Alert.Description>
			</Alert.Root>
		{/if}

		<RadioGroup.Root
			value={currentBackend}
			onValueChange={handleBackendChange}
			{disabled}
			class="gap-2"
		>
			{#each backends as backend (backend.id)}
				{@const isCoreAudio = backend.id === 'screencapturekit'}
				{@const isDisabled = disabled || isCoreAudio}
				<Label
					for={`backend-${backend.id}`}
					class={cn(
						'flex items-start gap-3 rounded-lg border p-3 transition-all',
						currentBackend === backend.id
							? 'border-accent bg-accent/5'
							: 'border-input bg-background hover:border-muted-foreground/40',
						isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
					)}
				>
					<RadioGroup.Item
						id={`backend-${backend.id}`}
						value={backend.id}
						disabled={isDisabled}
						class="mt-1"
					/>
					<div class="flex-1">
						<div class="flex items-center justify-between">
							<span class="text-sm font-medium">{backend.name}</span>
							{#if currentBackend === backend.id}
								<Badge variant="secondary" class="text-accent">Active</Badge>
							{:else if isCoreAudio}
								<Badge variant="secondary">Disabled</Badge>
							{/if}
						</div>
						<p class="mt-1 text-xs font-normal text-muted-foreground">{backend.description}</p>
					</div>
				</Label>
			{/each}
		</RadioGroup.Root>

		<div class="flex flex-col gap-1 text-xs text-muted-foreground">
			<p>• Backend selection only affects system audio capture</p>
			<p>• Microphone always uses the default method</p>
			<p>• Changes apply to new recording sessions</p>
		</div>
	</div>
{/if}
