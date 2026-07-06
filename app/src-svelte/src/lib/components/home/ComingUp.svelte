<script lang="ts">
	import { onMount } from 'svelte';
	import { SlidersHorizontal } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import { commands, type PreviewEvent } from '$lib/bindings';
	import { cn } from '$lib/utils';
	import { groupPreviewEventsByDay, formatEventTime } from '$lib/coming-up';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let events = $state<PreviewEvent[]>([]);
	const groups = $derived(groupPreviewEventsByDay(events));

	onMount(() => {
		void (async () => {
			// Self-gating: returns [] when calendar context is off or no source is
			// connected, so the whole card is hidden.
			const res = await commands.calendarPreviewUpcoming();
			if (res.status === 'ok') events = res.data;
		})();
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
								onclick={() => goto('/settings')}
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
							<div class="flex items-start gap-3">
								<div class="mt-0.5 h-8 w-0.5 flex-shrink-0 rounded-full bg-success/60"></div>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium">{ev.title}</div>
									<div class="truncate text-xs text-muted-foreground">
										{formatEventTime(ev.start)}
										{#if ev.calendar_name}
											· {ev.calendar_name}
										{/if}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</section>
{/if}
