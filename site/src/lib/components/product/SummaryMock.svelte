<script lang="ts">
	import BadgeCheck from '@lucide/svelte/icons/badge-check';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { meeting, summary } from './mock-data';

	const templates = ['Standard', 'Action items', 'Decisions', 'Clean transcript'];
</script>

<div
	role="img"
	aria-label="A muesly meeting summary showing the overview, key decisions, and action items"
	class="overflow-hidden rounded-2xl border border-border bg-card shadow-lg"
>
	<div class="flex items-center gap-2 border-b border-border px-5 py-3">
		<Sparkles class="h-4 w-4 text-accent" aria-hidden="true" />
		<span class="text-sm font-medium">Summary</span>
		<span class="ml-auto text-xs text-muted-foreground">{meeting.meta}</span>
	</div>

	<div class="p-5">
		<div class="flex flex-wrap gap-1.5">
			{#each templates as template, i (template)}
				<span
					class={i === 0
						? 'rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent'
						: 'rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground'}
				>
					{template}
				</span>
			{/each}
		</div>

		<h3 class="mt-4 font-display text-xl font-semibold">{meeting.title}</h3>
		<p class="mt-1.5 text-sm text-muted-foreground">{summary.overview}</p>

		<div class="mt-4">
			<div class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
				Key decisions
			</div>
			<ul class="mt-2 space-y-1.5">
				{#each summary.decisions as decision (decision)}
					<li class="flex items-start gap-2 text-sm">
						<BadgeCheck class="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
						<span>{decision}</span>
					</li>
				{/each}
			</ul>
		</div>

		<div class="mt-4">
			<div class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
				Action items
			</div>
			<ul class="mt-2 space-y-1.5">
				{#each summary.actions as action (action.task)}
					<li class="flex items-start gap-2 text-sm">
						<CircleCheck class="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
						<span><span class="font-medium text-foreground">{action.who}:</span> {action.task}</span>
					</li>
				{/each}
			</ul>
		</div>
	</div>
</div>
