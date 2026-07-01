<script lang="ts">
	import { Lock, Sparkles, Cpu } from '@lucide/svelte';
	import type { Component } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Separator } from '$lib/components/ui/separator';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import OnboardingContainer from '../OnboardingContainer.svelte';

	const features: { icon: Component; title: string }[] = [
		{ icon: Lock, title: 'Your data never leaves your device' },
		{ icon: Sparkles, title: 'Intelligent summaries & insights' },
		{ icon: Cpu, title: 'Works offline, no cloud required' },
	];
</script>

<OnboardingContainer
	title="Welcome to muesly"
	description="Record. Transcribe. Summarize. All on your device."
	step={1}
	hideProgress={true}
>
	<div class="flex flex-col items-center gap-10">
		<!-- Divider -->
		<Separator class="w-16" />

		<!-- Features Card -->
		<Card.Root class="w-full max-w-md">
			<Card.Content class="flex flex-col gap-4">
				{#each features as feature (feature.title)}
					{@const Icon = feature.icon}
					<div class="flex items-start gap-3">
						<div class="flex-shrink-0 mt-0.5">
							<div class="flex size-5 items-center justify-center rounded-full bg-muted">
								<Icon class="size-3 text-foreground" />
							</div>
						</div>
						<p class="text-sm text-foreground leading-relaxed">{feature.title}</p>
					</div>
				{/each}
			</Card.Content>
		</Card.Root>

		<!-- CTA Section -->
		<div class="flex w-full max-w-xs flex-col gap-3">
			<Button onclick={() => onboarding.goNext()} class="h-11 w-full">Get Started</Button>
			<p class="text-xs text-center text-muted-foreground">Takes less than 3 minutes</p>
		</div>
	</div>
</OnboardingContainer>
