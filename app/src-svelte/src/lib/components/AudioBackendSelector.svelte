<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Info } from '@lucide/svelte';
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
	let showTooltip = $state(false);

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
	<div class="animate-pulse">
		<div class="mb-2 h-4 w-32 rounded bg-secondary"></div>
		<div class="h-10 rounded bg-secondary"></div>
	</div>
{:else if backends.length > 1}
	<div class="space-y-2">
		<div class="flex items-center gap-2">
			<span class="text-sm font-medium">System Audio Backend</span>
			<div class="relative">
				<button
					type="button"
					onmouseenter={() => (showTooltip = true)}
					onmouseleave={() => (showTooltip = false)}
					class="text-muted-foreground transition-colors hover:text-foreground"
					aria-label="Backend info"
				>
					<Info class="size-4" />
				</button>
				{#if showTooltip}
					<div
						class="absolute left-6 top-0 z-10 w-64 rounded-lg bg-primary p-3 text-xs text-primary-foreground shadow-lg"
					>
						<p class="mb-1 font-semibold">Audio Capture Methods:</p>
						<ul class="space-y-1">
							{#each backends as backend (backend.id)}
								<li><span class="font-medium">{backend.name}:</span> {backend.description}</li>
							{/each}
						</ul>
						<p class="mt-2 text-primary-foreground/70">
							Try different backends to find which works best for your system.
						</p>
					</div>
				{/if}
			</div>
		</div>

		{#if error}
			<div class="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
				{error}
			</div>
		{/if}

		<div class="space-y-2">
			{#each backends as backend (backend.id)}
				{@const isCoreAudio = backend.id === 'screencapturekit'}
				{@const isDisabled = disabled || isCoreAudio}
				<label
					class={cn(
						'flex items-start rounded-lg border p-3 transition-all',
						currentBackend === backend.id
							? 'border-accent bg-accent/5'
							: 'border-input bg-background hover:border-muted-foreground/40',
						isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
					)}
				>
					<input
						type="radio"
						name="audioBackend"
						value={backend.id}
						checked={currentBackend === backend.id}
						onchange={() => handleBackendChange(backend.id)}
						disabled={isDisabled}
						class="mt-1 size-4"
					/>
					<div class="ml-3 flex-1">
						<div class="flex items-center justify-between">
							<span class="text-sm font-medium">{backend.name}</span>
							{#if currentBackend === backend.id}
								<span class="rounded bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">Active</span>
							{:else if isCoreAudio}
								<span class="rounded bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">Disabled</span>
							{/if}
						</div>
						<p class="mt-1 text-xs text-muted-foreground">{backend.description}</p>
					</div>
				</label>
			{/each}
		</div>

		<div class="space-y-1 text-xs text-muted-foreground">
			<p>• Backend selection only affects system audio capture</p>
			<p>• Microphone always uses the default method</p>
			<p>• Changes apply to new recording sessions</p>
		</div>
	</div>
{/if}
