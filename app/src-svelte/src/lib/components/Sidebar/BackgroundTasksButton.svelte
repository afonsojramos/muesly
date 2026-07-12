<script lang="ts">
	import { goto } from '$app/navigation';
	import { CheckCircle2, ListChecks, LoaderCircle, TriangleAlert, X } from '@lucide/svelte';
	import { onMount } from 'svelte';

	import { mergeProps } from 'bits-ui';

	import { backgroundTasks, type BackgroundTask } from '$lib/stores/background-tasks.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { Progress } from '$lib/components/ui/progress';
	import * as Tooltip from '$lib/components/ui/tooltip';

	onMount(() => {
		backgroundTasks.init();
	});

	const running = $derived(backgroundTasks.runningCount);

	function openTask(task: BackgroundTask): void {
		void goto(`/meeting-details?id=${task.meetingId}`);
	}
</script>

<Popover.Root>
	<Tooltip.Provider delayDuration={300}>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props: tooltipProps })}
					<Popover.Trigger>
						{#snippet child({ props: popoverProps })}
							<!-- mergeProps chains shared handlers/attrs instead of letting the
							     popover props clobber the tooltip's (plain double-spread breaks
							     the tooltip). -->
							<Button
								{...mergeProps(tooltipProps, popoverProps)}
								variant="ghost"
								size="icon-sm"
								class="relative text-muted-foreground/70"
								aria-label={running > 0
									? `Background tasks (${running} running)`
									: 'Background tasks'}
							>
								{#if running > 0}
									<LoaderCircle class="animate-spin" />
									<span
										class="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-brand text-[9px] font-semibold leading-none text-brand-foreground"
									>
										{running}
									</span>
								{:else}
									<ListChecks />
								{/if}
							</Button>
						{/snippet}
					</Popover.Trigger>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Background tasks</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
	<Popover.Content align="start" class="w-80 p-2">
		{#if backgroundTasks.tasks.length === 0}
			<p class="px-2 py-3 text-center text-sm text-muted-foreground">No background tasks</p>
		{:else}
			<div class="flex flex-col gap-1">
				{#each backgroundTasks.tasks as task (task.id)}
					<div class="flex items-start gap-2 rounded-md p-2 transition-colors hover:bg-secondary">
						<div class="mt-0.5 flex-shrink-0">
							{#if task.status === 'running'}
								<LoaderCircle class="size-4 animate-spin text-muted-foreground" />
							{:else if task.status === 'done'}
								<CheckCircle2 class="size-4 text-success" />
							{:else}
								<TriangleAlert class="size-4 text-destructive" />
							{/if}
						</div>
						<button
							type="button"
							class="min-w-0 flex-1 text-left"
							onclick={() => openTask(task)}
							aria-label={`Open ${task.label}`}
						>
							<div class="truncate text-sm font-medium">{task.label}</div>
							{#if task.status === 'running' && task.progress !== null}
								<Progress value={task.progress} class="mt-1.5 h-1" />
							{/if}
							{#if task.detail}
								<div
									class={task.status === 'error'
										? 'mt-0.5 truncate text-xs text-destructive'
										: 'mt-0.5 truncate text-xs text-muted-foreground'}
								>
									{task.detail}
								</div>
							{/if}
						</button>
						{#if task.status !== 'running'}
							<Button
								variant="ghost"
								size="icon-xs"
								class="flex-shrink-0 text-muted-foreground"
								onclick={() => backgroundTasks.dismiss(task.id)}
								aria-label="Dismiss task"
							>
								<X />
							</Button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
