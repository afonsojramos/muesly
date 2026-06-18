<script lang="ts">
	import { getVersion } from '@tauri-apps/api/app';
	import { invoke } from '@tauri-apps/api/core';
	import { CheckCircle2, Cpu, Globe, Loader2, ShieldCheck, Sparkles, Wallet } from '@lucide/svelte';
	import { onMount } from 'svelte';

	import Button from '$lib/ui/button.svelte';
	import { useUpdateCheck } from '$lib/hooks/use-update-check.svelte';
	import { toast } from '$lib/toast';

	let currentVersion = $state('0.1.0');
	const updates = useUpdateCheck({ checkOnMount: false });

	onMount(() => {
		getVersion().then((v) => (currentVersion = v)).catch(console.error);
	});

	async function handleCheckForUpdates(): Promise<void> {
		await updates.checkForUpdates(true);
		if (!updates.updateInfo?.available) {
			toast.success('You are running the latest version');
		}
	}

	async function handleContactClick(): Promise<void> {
		try {
			await invoke('open_external_url', { url: 'TBD' });
		} catch (error) {
			console.error('Failed to open link:', error);
		}
	}

	const features: { title: string; body: string; icon: typeof ShieldCheck }[] = [
		{
			title: 'Privacy-first',
			body: 'Your data & AI processing can stay within your premises. No cloud, no leaks.',
			icon: ShieldCheck
		},
		{
			title: 'Use Any Model',
			body: 'Prefer a local open-source model? Great. Want an external API? Also fine. No lock-in.',
			icon: Cpu
		},
		{
			title: 'Cost-Smart',
			body: 'Avoid pay-per-minute bills by running models locally (or pay only for what you choose).',
			icon: Wallet
		},
		{
			title: 'Works everywhere',
			body: 'Google Meet, Zoom, Teams — online or offline.',
			icon: Globe
		}
	];
</script>

<div class="space-y-6">
	<!-- Identity -->
	<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
		<div class="flex flex-col items-center text-center">
			<img src="/muesly.svg" alt="muesly" width={64} height={64} class="rounded-2xl" />
			<div class="mt-3 flex items-center gap-2">
				<h2 class="font-display text-2xl font-semibold tracking-tight">muesly</h2>
				<span
					class="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
				>
					v{currentVersion}
				</span>
			</div>
			<p class="mt-2 max-w-sm text-sm text-muted-foreground">
				Real-time notes and summaries that never leave your machine.
			</p>
			<div class="mt-4 flex flex-col items-center gap-2">
				<Button
					onclick={handleCheckForUpdates}
					disabled={updates.isChecking}
					variant="outline"
					size="sm"
				>
					{#if updates.isChecking}
						<Loader2 class="size-3 animate-spin" /> Checking...
					{:else}
						<CheckCircle2 class="size-3" /> Check for Updates
					{/if}
				</Button>
				{#if updates.updateInfo?.available}
					<span class="text-xs text-accent">Update available: v{updates.updateInfo.version}</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- What makes muesly different -->
	<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
		<h3 class="text-lg font-semibold">What makes muesly different</h3>
		<div class="mt-4 grid gap-3 sm:grid-cols-2">
			{#each features as feature (feature.title)}
				{@const Icon = feature.icon}
				<div
					class="rounded-lg border border-border bg-secondary/40 p-4 transition-colors hover:bg-secondary/60"
				>
					<div class="flex size-9 items-center justify-center rounded-md bg-accent/10 text-accent">
						<Icon class="size-5" />
					</div>
					<h4 class="mt-3 text-sm font-semibold">{feature.title}</h4>
					<p class="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.body}</p>
				</div>
			{/each}
		</div>
	</div>

	<!-- Coming soon -->
	<div class="flex gap-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
		<Sparkles class="mt-0.5 size-4 flex-shrink-0 text-accent" />
		<p class="text-sm text-foreground">
			<span class="font-semibold">Coming soon:</span> A library of on-device AI agents — automating
			follow-ups, action tracking, and more.
		</p>
	</div>

	<!-- Contact -->
	<div class="rounded-lg border border-border bg-card p-6 text-center shadow-sm">
		<h3 class="text-lg font-semibold">Ready to push your business further?</h3>
		<p class="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
			If you're planning to build privacy-first custom AI agents or a fully tailored product, we can
			help you build it.
		</p>
		<div class="mt-4">
			<Button variant="accent" onclick={handleContactClick}>Chat with the muesly team</Button>
		</div>
	</div>

	<p class="text-center text-xs text-muted-foreground/60">Built by muesly</p>
</div>
