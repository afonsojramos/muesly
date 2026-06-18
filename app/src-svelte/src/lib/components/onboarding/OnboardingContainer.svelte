<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fly } from 'svelte/transition';
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import ProgressIndicator from './shared/ProgressIndicator.svelte';

	interface Props {
		title: string;
		description?: string;
		children: Snippet;
		step?: number;
		totalSteps?: number;
		stepOffset?: number;
		hideProgress?: boolean;
		class?: string;
		showNavigation?: boolean;
		onNext?: () => void;
		onPrevious?: () => void;
		canGoNext?: boolean;
		canGoPrevious?: boolean;
	}

	let {
		title,
		description,
		children,
		step,
		totalSteps = 5,
		stepOffset = 0,
		hideProgress = false,
		class: className,
		showNavigation = false,
		onNext,
		onPrevious,
		canGoNext = true,
		canGoPrevious = true
	}: Props = $props();

	function handlePrevious(): void {
		if (onPrevious) onPrevious();
		else onboarding.goPrevious();
	}

	function handleNext(): void {
		if (onNext) onNext();
		else onboarding.goNext();
	}

	function handleStepClick(s: number): void {
		onboarding.goToStep(s + stepOffset);
	}
</script>

<div
	class="fixed inset-0 bg-background flex items-center justify-center z-50 overflow-hidden"
>
	<div
		class={cn('w-full max-w-2xl h-full max-h-screen flex flex-col px-6 py-6', className)}
	>
		<!-- Progress Indicator with Navigation - Fixed -->
		{#if step && !hideProgress}
			<div class="mb-2 relative flex-shrink-0">
				{#if showNavigation}
					<div
						class="absolute top-1/2 -translate-y-1/2 left-0 right-0 flex justify-between pointer-events-none"
					>
						<button
							type="button"
							onclick={handlePrevious}
							disabled={!canGoPrevious || step === 1}
							class={cn(
								'pointer-events-auto w-8 h-8 rounded-full bg-card border border-border shadow-sm flex items-center justify-center transition-all duration-200',
								canGoPrevious && step !== 1
									? 'hover:bg-secondary hover:shadow-md hover:scale-110 text-foreground'
									: 'opacity-0 cursor-not-allowed'
							)}
						>
							<ChevronLeft class="w-4 h-4" />
						</button>

						<button
							type="button"
							onclick={handleNext}
							disabled={!canGoNext || step === totalSteps}
							class={cn(
								'pointer-events-auto w-8 h-8 rounded-full bg-card border border-border shadow-sm flex items-center justify-center transition-all duration-200',
								canGoNext && step !== totalSteps
									? 'hover:bg-secondary hover:shadow-md hover:scale-110 text-foreground'
									: 'opacity-0 cursor-not-allowed'
							)}
						>
							<ChevronRight class="w-4 h-4" />
						</button>
					</div>
				{/if}

				<ProgressIndicator current={step} total={totalSteps} onStepClick={handleStepClick} />
			</div>
		{/if}

		<!-- Header - Fixed -->
		<div class="mb-4 text-center space-y-3 flex-shrink-0">
			<h1
				class="text-4xl font-semibold text-foreground"
				in:fly={{ y: 10, duration: 300 }}
			>
				{title}
			</h1>
			{#if description}
				<p
					class="text-base text-muted-foreground max-w-md mx-auto"
					in:fly={{ y: 10, duration: 300, delay: 75 }}
				>
					{description}
				</p>
			{/if}
		</div>

		<!-- Content - Scrollable -->
		<div class="flex-1 overflow-y-auto pr-2">
			<div class="space-y-6">
				{@render children()}
			</div>
		</div>
	</div>
</div>
