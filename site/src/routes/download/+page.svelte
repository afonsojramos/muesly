<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Laptop from '@lucide/svelte/icons/laptop';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Terminal from '@lucide/svelte/icons/terminal';
	import Seo from '$lib/components/Seo.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Section from '$lib/ui/Section.svelte';
	import { BUILD_GUIDE_URL, GITHUB_URL, RELEASES_URL } from '$lib/config';
	import { cn } from '$lib/utils/cn';
	import { detectOS, type OS } from '$lib/utils/detect-os';

	const ext = { target: '_blank', rel: 'noopener noreferrer' } as const;

	type Platform = {
		id: Exclude<OS, 'unknown'>;
		name: string;
		icon: Component;
		detail: string;
		cta: string;
		href: string;
		fromSource?: boolean;
	};

	const platforms: Platform[] = [
		{
			id: 'macos',
			name: 'macOS',
			icon: Laptop,
			detail: 'Apple Silicon · .dmg',
			cta: 'Download for Mac',
			href: RELEASES_URL
		},
		{
			id: 'windows',
			name: 'Windows',
			icon: Monitor,
			detail: 'x64 · .exe installer',
			cta: 'Download for Windows',
			href: RELEASES_URL
		},
		{
			id: 'linux',
			name: 'Linux',
			icon: Terminal,
			detail: 'Requires Rust + Node toolchain',
			cta: 'Build from source',
			href: BUILD_GUIDE_URL,
			fromSource: true
		}
	];

	let detected = $state<OS>('unknown');
	onMount(() => {
		detected = detectOS({ userAgent: navigator.userAgent, platform: navigator.platform });
	});

	// Promote the detected platform to the front; equal ordering otherwise.
	const ordered = $derived(
		detected === 'unknown'
			? platforms
			: [...platforms].sort((a, b) => Number(b.id === detected) - Number(a.id === detected))
	);
</script>

<Seo
	title="Download muesly — macOS, Windows, Linux"
	description="Download muesly for macOS or Windows, or build from source on Linux. Free and open source, no account required."
/>

<Section class="py-16 md:py-24">
	<div class="mx-auto max-w-2xl text-center">
		<h1 class="font-display text-4xl font-semibold tracking-tight md:text-5xl">Download muesly</h1>
		<p class="mt-4 text-lg text-muted-foreground">
			Free and open source. No account required. Pick your platform below.
		</p>
	</div>

	<div class="mx-auto mt-12 grid max-w-4xl gap-5 md:grid-cols-3">
		{#each ordered as platform (platform.id)}
			{@const promoted = platform.id === detected}
			<div
				class={cn(
					'flex flex-col rounded-2xl border bg-card p-6 transition-shadow',
					promoted ? 'border-accent shadow-lg ring-1 ring-accent/30' : 'border-border shadow-sm'
				)}
			>
				<div class="flex items-center justify-between">
					<platform.icon class="h-7 w-7 text-foreground" aria-hidden="true" />
					{#if promoted}
						<Badge class="border-accent/40 bg-accent/10 text-accent">Recommended for you</Badge>
					{/if}
				</div>
				<h2 class="mt-4 text-xl font-semibold">{platform.name}</h2>
				<p class="mt-1 text-sm text-muted-foreground">{platform.detail}</p>
				<div class="mt-6">
					<Button
						href={platform.href}
						variant={promoted ? 'accent' : 'outline'}
						class="w-full"
						{...ext}
					>
						{platform.cta}
						<ArrowRight class="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			</div>
		{/each}
	</div>

	<p class="mx-auto mt-8 max-w-2xl text-center text-sm text-muted-foreground">
		macOS builds target Apple Silicon. If the first launch is blocked, open the app from
		Applications with right-click → Open. Prefer to inspect before running?
		<a class="text-accent underline underline-offset-2" href={GITHUB_URL} {...ext}>
			View the source on GitHub
			<ExternalLink class="inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
		</a>
	</p>
</Section>
