<script lang="ts">
	import { getVersion } from '@tauri-apps/api/app';
	import { invoke } from '@tauri-apps/api/core';
	import {
		AudioLines,
		CheckCircle2,
		ExternalLink,
		GitFork,
		Globe,
		HardDrive,
		Loader2,
		LockKeyhole,
		MessageSquareWarning,
		ShieldCheck,
		Sparkles,
	} from '@lucide/svelte';
	import { onMount } from 'svelte';

	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Separator } from '$lib/components/ui/separator';
	import { useUpdateCheck } from '$lib/hooks/use-update-check.svelte';
	import { toast } from '$lib/toast';

	const links = {
		website: 'https://muesly.ai',
		github: 'https://github.com/afonsojramos/muesly',
		issues: 'https://github.com/afonsojramos/muesly/issues',
		privacy: 'https://github.com/afonsojramos/muesly/blob/main/PRIVACY_POLICY.md',
	} as const;

	let currentVersion = $state('0.2.0');
	let updateMessage = $state<string | null>(null);
	const updates = useUpdateCheck({ checkOnMount: false });

	onMount(() => {
		getVersion()
			.then((version) => (currentVersion = version))
			.catch((error) => console.error('[About] Failed to read app version:', error));
	});

	async function handleCheckForUpdates(): Promise<void> {
		updateMessage = null;
		await updates.checkForUpdates(true);
		if (!updates.updateInfo?.available) updateMessage = 'You’re up to date';
	}

	async function openExternal(url: string): Promise<void> {
		try {
			await invoke('open_external_url', { url });
		} catch (error) {
			console.error('[About] Failed to open external link:', error);
			toast.error('Could not open the link');
		}
	}

	const principles: {
		title: string;
		body: string;
		icon: typeof ShieldCheck;
	}[] = [
		{
			title: 'Your conversations stay yours',
			body: 'Recordings, transcripts, and app data are stored on this device, not in a muesly account.',
			icon: LockKeyhole,
		},
		{
			title: 'Speech-to-text runs locally',
			body: 'Whisper and Parakeet transcribe microphone and system audio without sending it to a backend.',
			icon: AudioLines,
		},
		{
			title: 'AI stays under your control',
			body: 'Use the built-in local model, Ollama, or an optional cloud provider that you configure yourself.',
			icon: Sparkles,
		},
		{
			title: 'Source available',
			body: 'Inspect how muesly handles your data, follow development, or contribute on GitHub.',
			icon: GitFork,
		},
	];
</script>

<div class="flex flex-col gap-6">
	<Card.Root class="relative bg-gradient-to-br from-card via-card to-brand/5">
		<Card.Content class="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
			<div class="flex min-w-0 items-start gap-4">
				<img
					src="/muesly.svg"
					alt=""
					width={72}
					height={72}
					class="size-16 shrink-0 rounded-2xl ring-1 ring-black/10 dark:ring-white/10 sm:size-[4.5rem]"
				/>
				<div class="min-w-0 pt-0.5">
					<div class="flex flex-wrap items-center gap-2">
						<h2 class="font-display text-3xl font-semibold tracking-tight text-balance">muesly</h2>
						<Badge variant="secondary" class="tabular-nums">v{currentVersion}</Badge>
					</div>
					<p class="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground text-pretty">
						Private speech-to-text for everything you say. Capture, transcribe, organize, and ask
						questions across your conversations on your own device.
					</p>
				</div>
			</div>

			<Button
				onclick={handleCheckForUpdates}
				disabled={updates.isChecking}
				variant="outline"
				class="sm:shrink-0"
			>
				{#if updates.isChecking}
					<Loader2 data-icon="inline-start" class="animate-spin" />
					Checking…
				{:else}
					<CheckCircle2 data-icon="inline-start" />
					Check for updates
				{/if}
			</Button>
		</Card.Content>

		{#if updates.updateInfo?.available || updateMessage}
			<Card.Footer class="flex items-center justify-between gap-3 bg-secondary/50 py-3 text-xs">
				{#if updates.updateInfo?.available}
					<span class="font-medium text-brand">
						Version {updates.updateInfo.version} is available
					</span>
				{:else}
					<span class="flex items-center gap-1.5 text-muted-foreground">
						<CheckCircle2 class="size-3.5 text-brand" />
						{updateMessage}
					</span>
				{/if}
			</Card.Footer>
		{/if}
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Private by design</Card.Title>
			<Card.Description>
				The app is built around local ownership, with cloud services remaining optional.
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-x-8 gap-y-6 sm:grid-cols-2">
			{#each principles as principle (principle.title)}
				{@const Icon = principle.icon}
				<div class="flex items-start gap-3">
					<div
						class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"
					>
						<Icon class="size-4.5" />
					</div>
					<div class="min-w-0">
						<h3 class="text-sm font-medium">{principle.title}</h3>
						<p class="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
							{principle.body}
						</p>
					</div>
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Project and support</Card.Title>
			<Card.Description
				>Learn more, review the source, or tell us when something is wrong.</Card.Description
			>
		</Card.Header>
		<Separator />
		<Card.Content class="grid gap-2 sm:grid-cols-2">
			<Button
				variant="ghost"
				class="h-10 justify-start"
				onclick={() => openExternal(links.website)}
			>
				<Globe data-icon="inline-start" />
				Website
				<ExternalLink data-icon="inline-end" class="ml-auto text-muted-foreground" />
			</Button>
			<Button variant="ghost" class="h-10 justify-start" onclick={() => openExternal(links.github)}>
				<GitFork data-icon="inline-start" />
				Source on GitHub
				<ExternalLink data-icon="inline-end" class="ml-auto text-muted-foreground" />
			</Button>
			<Button
				variant="ghost"
				class="h-10 justify-start"
				onclick={() => openExternal(links.privacy)}
			>
				<ShieldCheck data-icon="inline-start" />
				Privacy policy
				<ExternalLink data-icon="inline-end" class="ml-auto text-muted-foreground" />
			</Button>
			<Button variant="ghost" class="h-10 justify-start" onclick={() => openExternal(links.issues)}>
				<MessageSquareWarning data-icon="inline-start" />
				Report an issue
				<ExternalLink data-icon="inline-end" class="ml-auto text-muted-foreground" />
			</Button>
		</Card.Content>
	</Card.Root>

	<div class="flex items-center justify-center gap-2 text-xs text-muted-foreground">
		<HardDrive class="size-3.5" />
		<span>Built to keep your conversations on your machine.</span>
	</div>
</div>
