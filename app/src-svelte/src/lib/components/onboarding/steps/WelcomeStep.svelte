<script lang="ts">
	import { Lock, Sparkles, Cpu } from '@lucide/svelte';
	import type { Component } from 'svelte';
	import Button from '$lib/ui/button.svelte';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import OnboardingContainer from '../OnboardingContainer.svelte';

	const features: { icon: Component; title: string }[] = [
		{ icon: Lock, title: 'Your data never leaves your device' },
		{ icon: Sparkles, title: 'Intelligent summaries & insights' },
		{ icon: Cpu, title: 'Works offline, no cloud required' }
	];
</script>

<OnboardingContainer
	title="Welcome to muesly"
	description="Record. Transcribe. Summarize. All on your device."
	step={1}
	hideProgress={true}
>
	<div class="flex flex-col items-center space-y-10">
		<!-- Divider -->
		<div class="w-16 h-px bg-border"></div>

		<!-- Features Card -->
		<div class="w-full max-w-md bg-card rounded-lg border border-border shadow-sm p-6 space-y-4">
			{#each features as feature (feature.title)}
				{@const Icon = feature.icon}
				<div class="flex items-start gap-3">
					<div class="flex-shrink-0 mt-0.5">
						<div class="w-5 h-5 rounded-full bg-muted flex items-center justify-center">
							<Icon class="w-3 h-3 text-foreground" />
						</div>
					</div>
					<p class="text-sm text-foreground leading-relaxed">{feature.title}</p>
				</div>
			{/each}
		</div>

		<!-- CTA Section -->
		<div class="w-full max-w-xs space-y-3">
			<Button onclick={() => onboarding.goNext()} class="w-full h-11">Get Started</Button>
			<p class="text-xs text-center text-muted-foreground">Takes less than 3 minutes</p>
		</div>
	</div>
</OnboardingContainer>
