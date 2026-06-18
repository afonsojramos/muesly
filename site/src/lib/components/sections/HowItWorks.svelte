<script lang="ts">
	import Mic from '@lucide/svelte/icons/mic';
	import FileText from '@lucide/svelte/icons/file-text';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Section from '$lib/ui/Section.svelte';
	import { reveal } from '$lib/actions/reveal';

	const steps = [
		{
			icon: Mic,
			title: 'Record',
			body: 'Capture microphone and system audio together, mixed locally. Nothing is uploaded.'
		},
		{
			icon: FileText,
			title: 'Transcribe',
			body: 'Whisper and Parakeet models run on-device, GPU-accelerated, in real time.'
		},
		{
			icon: Sparkles,
			title: 'Summarize',
			body: 'Get decisions and action items from a local LLM, or a cloud provider you choose.'
		}
	];
</script>

<Section class="py-16 md:py-24" id="how-it-works">
	<div class="mx-auto max-w-2xl text-center" use:reveal>
		<h2 class="font-display text-3xl font-semibold tracking-tight md:text-4xl">
			Three steps, all on your machine
		</h2>
		<p class="mt-3 text-muted-foreground">From a live meeting to a shareable summary, locally.</p>
	</div>

	<ol class="mt-12 grid gap-5 md:grid-cols-3" use:reveal>
		{#each steps as step, i (step.title)}
			<li class="rounded-2xl border border-border bg-card p-6 shadow-sm">
				<div class="flex items-center gap-3">
					<span
						class="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"
					>
						<step.icon class="h-5 w-5" aria-hidden="true" />
					</span>
					<span class="text-sm font-medium text-muted-foreground tabular-nums">
						Step {i + 1}
					</span>
				</div>
				<h3 class="mt-4 text-lg font-semibold">{step.title}</h3>
				<p class="mt-1.5 text-sm text-muted-foreground">{step.body}</p>
			</li>
		{/each}
	</ol>
</Section>
