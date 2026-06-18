<script lang="ts">
	import { Check, Lock, Download, CheckCircle2, BrainCircuit } from '@lucide/svelte';
	import type { Component } from 'svelte';

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
				class="relative flex items-center justify-center transition-all duration-300 {isCompleted
					? 'w-7 h-7 bg-green-600 rounded-full'
					: isActive
						? 'w-8 h-8 bg-primary rounded-full'
						: 'w-6 h-6 bg-muted-foreground/30 rounded-full'} {isClickable
					? 'cursor-pointer hover:scale-110 hover:shadow-md'
					: 'cursor-default'}"
			>
				{#if isCompleted}
					<Check class="w-4 h-4 text-white" />
				{:else}
					<StepIcon
						class="transition-all duration-300 {isActive
							? 'w-4 h-4 text-primary-foreground'
							: 'w-3 h-3 text-muted-foreground'}"
					/>
				{/if}
			</button>

			<!-- Connector Line -->
			{#if index < visibleSteps.length - 1}
				<div
					class="h-0.5 w-6 transition-all duration-300 {isCompleted
						? 'bg-green-600'
						: 'bg-muted-foreground/30'}"
				></div>
			{/if}
		{/each}
	</div>
</div>
