<script lang="ts">
	import RecordingMock from '$lib/components/product/RecordingMock.svelte';
	import SummaryMock from '$lib/components/product/SummaryMock.svelte';
	import { reveal } from '$lib/actions/reveal';
	import Section from '$lib/ui/Section.svelte';
</script>

<Section class="py-16 md:py-24">
	<div class="mx-auto max-w-2xl text-center" use:reveal>
		<h2 class="font-display text-3xl font-semibold tracking-tight md:text-4xl">
			See it while you talk
		</h2>
		<p class="mt-3 text-muted-foreground">
			A live transcript as the meeting happens, and a structured summary the moment it ends.
		</p>
	</div>

	<div class="mt-12 grid items-start gap-6 lg:grid-cols-2">
		<div use:reveal>
			<RecordingMock />
			<p class="mt-3 text-center text-sm text-muted-foreground">
				Live transcription while you take notes.
			</p>
		</div>
		<div use:reveal>
			<SummaryMock />
			<p class="mt-3 text-center text-sm text-muted-foreground">
				Decisions and action items, generated locally.
			</p>
		</div>
	</div>
</Section>
