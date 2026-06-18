<script lang="ts">
	import { onMount } from 'svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import BeforeAfterNotes from '$lib/components/product/BeforeAfterNotes.svelte';
	import { GITHUB_URL } from '$lib/config';
	import { osCta } from '$lib/cta';
	import Button from '$lib/ui/Button.svelte';
	import Section from '$lib/ui/Section.svelte';
	import { detectOS, type OS } from '$lib/utils/detect-os';

	let os = $state<OS>('unknown');
	onMount(() => {
		os = detectOS({ userAgent: navigator.userAgent, platform: navigator.platform });
	});

	const cta = $derived(osCta(os));
	const ext = $derived(cta.external ? { target: '_blank', rel: 'noopener noreferrer' } : {});
</script>

<Section class="pt-16 pb-12 text-center md:pt-24 md:pb-16">
	<h1
		class="mx-auto max-w-3xl font-display text-4xl leading-[1.08] font-semibold tracking-tight text-balance md:text-6xl"
	>
		Private meeting notes, done before your next call
	</h1>
	<p class="mx-auto mt-5 max-w-xl text-lg text-muted-foreground text-pretty">
		muesly records, transcribes, and summarizes your meetings on your device. On-device by default,
		no account required.
	</p>

	<div class="mt-8 flex flex-wrap items-center justify-center gap-3">
		<Button href={cta.href} variant="accent" size="lg" {...ext}>
			{cta.label}
			<ArrowRight class="h-4 w-4" aria-hidden="true" />
		</Button>
		<Button
			href={GITHUB_URL}
			variant="outline"
			size="lg"
			target="_blank"
			rel="noopener noreferrer"
		>
			View on GitHub
			<ExternalLink class="h-4 w-4" aria-hidden="true" />
		</Button>
	</div>

	<div class="mx-auto mt-14 max-w-4xl text-left">
		<BeforeAfterNotes />
	</div>
</Section>
