<script lang="ts">
	import AudioLines from '@lucide/svelte/icons/audio-lines';
	import Cpu from '@lucide/svelte/icons/cpu';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { reveal } from '$lib/actions/reveal';
	import Section from '$lib/ui/Section.svelte';

	const features = [
		{
			icon: Cpu,
			title: 'Local-first transcription',
			body: 'Whisper and Parakeet models run on-device with GPU acceleration on Apple Silicon, CUDA, and Vulkan. No cloud round-trip, no usage caps.',
			wide: true
		},
		{
			icon: Sparkles,
			title: 'Summaries your way',
			body: 'A local LLM by default, or bring Ollama, Claude, Groq, OpenRouter, or any OpenAI-compatible endpoint.',
			wide: false
		},
		{
			icon: Monitor,
			title: 'Works everywhere',
			body: 'Native builds for macOS, Windows, and Linux.',
			wide: false
		},
		{
			icon: AudioLines,
			title: 'Professional audio capture',
			body: 'Microphone and system audio mixed with smart ducking and clipping prevention, so every voice is clear.',
			wide: true
		}
	];
</script>

<Section class="py-16 md:py-24">
	<div class="mx-auto max-w-2xl text-center" use:reveal>
		<h2 class="font-display text-3xl font-semibold tracking-tight md:text-4xl">
			Built for real meetings
		</h2>
		<p class="mt-3 text-muted-foreground">Everything you need to capture a conversation, nothing that phones home.</p>
	</div>

	<div class="mt-12 grid gap-5 md:grid-cols-3" use:reveal>
		{#each features as feature (feature.title)}
			<div
				class="rounded-2xl border border-border bg-card p-6 shadow-sm {feature.wide
					? 'md:col-span-2'
					: ''}"
			>
				<span
					class="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"
				>
					<feature.icon class="h-5 w-5" aria-hidden="true" />
				</span>
				<h3 class="mt-4 text-lg font-semibold">{feature.title}</h3>
				<p class="mt-1.5 text-sm text-muted-foreground">{feature.body}</p>
			</div>
		{/each}
	</div>
</Section>
