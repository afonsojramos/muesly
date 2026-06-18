<script lang="ts">
	import Lock from '@lucide/svelte/icons/lock';
	import { reveal } from '$lib/actions/reveal';
	import Section from '$lib/ui/Section.svelte';

	const stats = [
		{ figure: '$4.4M', label: 'average cost of a data breach (IBM, 2024)' },
		{ figure: '€5.88B', label: 'in GDPR fines issued by 2025' },
		{ figure: '0', label: 'meeting recordings muesly sends to the cloud' }
	];
</script>

<Section class="py-16 md:py-24">
	<div class="rounded-3xl border border-border bg-card p-8 md:p-12" use:reveal>
		<div class="mx-auto max-w-2xl text-center">
			<span
				class="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/10 text-accent"
			>
				<Lock class="h-5 w-5" aria-hidden="true" />
			</span>
			<h2 class="mt-4 font-display text-3xl font-semibold tracking-tight md:text-4xl">
				Your conversations stay yours
			</h2>
			<p class="mt-3 text-muted-foreground">
				Meeting audio, transcripts, and summaries are processed and stored on your device. muesly is
				built for people whose conversations can't live on someone else's servers.
			</p>
			<p class="mt-2 text-sm text-muted-foreground">
				Anonymized usage analytics is opt-out, and cloud LLM summaries are opt-in only if you
				configure a provider.
				<a class="text-accent underline underline-offset-2" href="/privacy">Read the privacy policy.</a>
			</p>
		</div>

		<dl class="mx-auto mt-10 grid max-w-3xl gap-6 text-center sm:grid-cols-3">
			{#each stats as stat (stat.label)}
				<div>
					<dt class="font-display text-3xl font-semibold text-foreground tabular-nums">
						{stat.figure}
					</dt>
					<dd class="mt-1 text-sm text-muted-foreground">{stat.label}</dd>
				</div>
			{/each}
		</dl>
	</div>
</Section>
