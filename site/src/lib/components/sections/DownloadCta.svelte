<script lang="ts">
	import { onMount } from 'svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { reveal } from '$lib/actions/reveal';
	import { osCta } from '$lib/cta';
	import Button from '$lib/ui/Button.svelte';
	import { detectOS, type OS } from '$lib/utils/detect-os';

	let os = $state<OS>('unknown');
	onMount(() => {
		os = detectOS({ userAgent: navigator.userAgent, platform: navigator.platform });
	});

	const cta = $derived(osCta(os));
	const ext = $derived(cta.external ? { target: '_blank', rel: 'noopener noreferrer' } : {});
</script>

<section class="border-y border-border bg-secondary/40">
	<div class="mx-auto max-w-3xl px-6 py-16 text-center md:py-24" use:reveal>
		<h2 class="font-display text-3xl font-semibold tracking-tight md:text-4xl">
			Keep your meetings to yourself
		</h2>
		<p class="mt-3 text-muted-foreground">
			Free, open source, and private by design. Download muesly and run your next meeting on your own
			machine.
		</p>
		<div class="mt-8 flex flex-wrap justify-center gap-3">
			<Button href={cta.href} variant="accent" size="lg" {...ext}>
				{cta.label}
				<ArrowRight class="h-4 w-4" aria-hidden="true" />
			</Button>
			<Button href="/download" variant="outline" size="lg">All platforms</Button>
		</div>
	</div>
</section>
