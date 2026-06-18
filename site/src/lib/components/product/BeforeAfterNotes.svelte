<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { meeting, rawNotes, summary } from './mock-data';
</script>

<div
	role="img"
	aria-label="muesly turning rough meeting notes into a structured summary with decisions and action items"
	class="grid items-stretch gap-4 sm:grid-cols-[1fr_auto_1.35fr]"
>
	<!-- Rough notes -->
	<div class="rounded-2xl border border-border bg-card p-5 shadow-sm">
		<div class="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
			Your notes
		</div>
		<ul class="space-y-2 font-mono text-sm text-muted-foreground">
			{#each rawNotes as note (note)}
				<li>– {note}</li>
			{/each}
		</ul>
	</div>

	<!-- Arrow -->
	<div class="flex items-center justify-center">
		<div class="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-accent">
			<ArrowRight class="h-5 w-5 max-sm:rotate-90" aria-hidden="true" />
		</div>
	</div>

	<!-- muesly summary -->
	<div class="rounded-2xl border border-border bg-card p-5 shadow-sm">
		<div class="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-accent uppercase">
			<Sparkles class="h-3.5 w-3.5" aria-hidden="true" /> muesly summary
		</div>
		<h3 class="font-display text-lg font-semibold">{meeting.title}</h3>
		<p class="mt-1 text-sm text-muted-foreground">{summary.overview}</p>
		<div class="mt-3 space-y-1.5">
			{#each summary.actions as action (action.task)}
				<div class="flex items-start gap-2 text-sm">
					<CircleCheck class="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
					<span><span class="font-medium text-foreground">{action.who}:</span> {action.task}</span>
				</div>
			{/each}
		</div>
	</div>
</div>
