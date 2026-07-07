<script lang="ts">
	import { onMount } from 'svelte';
	import { SlidersHorizontal } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import { cn } from '$lib/utils';
	import { groupPreviewEventsByDay } from '$lib/coming-up';
	import { upcomingEvents } from '$lib/stores/upcoming-events.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import EventRow from './EventRow.svelte';

	// Served from a session cache: instant on revisit, refreshed in the background.
	// Self-gating: the preview is [] when calendar context is off or no source is
	// connected, so the whole card stays hidden.
	const groups = $derived(groupPreviewEventsByDay(upcomingEvents.events));

	// A coarse clock so each row's "Start" button appears/hides as a meeting nears,
	// even while the dashboard sits open and focused (the app otherwise avoids
	// timers). Also nudges the event list so started meetings drop off.
	let nowMs = $state(Date.now());

	onMount(() => {
		void upcomingEvents.ensure();
		const interval = setInterval(() => {
			nowMs = Date.now();
			void upcomingEvents.refresh();
		}, 30_000);
		return () => clearInterval(interval);
	});
</script>

{#if groups.length > 0}
	<section class="mb-8">
		<div class="mb-2 flex items-center justify-between">
			<h2 class="text-2xl font-semibold tracking-tight">Coming up</h2>
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								class="text-muted-foreground"
								onclick={() => goto('/settings?tab=calendar')}
								aria-label="Calendar settings"
							>
								<SlidersHorizontal />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Calendar settings</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		</div>

		<div class="overflow-hidden rounded-xl border border-border bg-card">
			{#each groups as group, i (group.key)}
				<div class={cn('flex gap-4 px-4 py-3', i > 0 && 'border-t border-border')}>
					<div class="w-11 flex-shrink-0 pt-0.5 text-center">
						<div class="text-2xl font-semibold leading-none">{group.day}</div>
						<div class="mt-1 text-xs text-muted-foreground">{group.month}</div>
						<div class="text-xs text-muted-foreground">
							{group.isToday ? 'Today' : group.weekday}
						</div>
					</div>
					<div class="flex min-w-0 flex-1 flex-col gap-3">
						{#each group.items as ev (ev.start + ev.title)}
							<EventRow {ev} {nowMs} />
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</section>
{/if}
