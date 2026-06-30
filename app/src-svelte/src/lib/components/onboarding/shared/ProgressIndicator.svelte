<script lang="ts">
	import { Check, Lock, Download, CheckCircle2, BrainCircuit } from '@lucide/svelte';
	import type { Component } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		current: number;
		total: number;
		onStepClick?: (step: number) => void;
	}

	let { current, total, onStepClick }: Props = $props();

	// 1. Welcome, 2. Setup Overview, 3. Download Progress.
	// Step 4 (Permissions) has no icon — auto-skipped on non-macOS.
	const stepIcons: Component[] = [Lock, BrainCircuit, Download];

	const visibleSteps = $derived(Array.from({ length: total }, (_, i) => i + 1));
</script>

<div class="mb-8">
	<div class="flex items-center justify-center gap-2">
		{#each visibleSteps as step, index (step)}
			{@const isActive = step === current}
			{@const isCompleted = step < current}
			{@const isClickable = isCompleted && !!onStepClick}
			{@const StepIcon = stepIcons[step - 1] ?? CheckCircle2}

			<!-- Step Circle -->
			<button
				type="button"
				onclick={() => isClickable && onStepClick?.(step)}
				disabled={!isClickable}
				class={cn(
					'relative flex items-center justify-center rounded-full transition-all duration-300',
					isCompleted
						? 'size-7 bg-success'
						: isActive
							? 'size-8 bg-primary'
							: 'size-6 bg-muted-foreground/30',
					isClickable ? 'cursor-pointer hover:scale-110 hover:shadow-md' : 'cursor-default'
				)}
			>
				{#if isCompleted}
					<Check class="size-4 text-success-foreground" />
				{:else}
					<StepIcon
						class={cn(
							'transition-all duration-300',
							isActive ? 'size-4 text-primary-foreground' : 'size-3 text-muted-foreground'
						)}
					/>
				{/if}
			</button>

			<!-- Connector Line -->
			{#if index < visibleSteps.length - 1}
				<div
					class={cn(
						'h-0.5 w-6 transition-all duration-300',
						isCompleted ? 'bg-success' : 'bg-muted-foreground/30'
					)}
				></div>
			{/if}
		{/each}
	</div>
</div>
