<script lang="ts">
	import { Info } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import OnboardingContainer from '../OnboardingContainer.svelte';

	const platform = usePlatform();

	const steps = [
		{ number: 1, type: 'transcription', title: 'Download Transcription Engine' },
		{ number: 2, type: 'summarization', title: 'Download Summarization Engine' }
	] as const;

	const totalSteps = $derived(platform.isMac ? 4 : 3);
</script>

<OnboardingContainer
	title="Setup Overview"
	description="muesly requires that you download the Transcription & Summarization AI models for the software to work."
	step={2}
	{totalSteps}
>
	<div class="flex flex-col items-center gap-10">
		<!-- Steps Card -->
		<Card.Root class="w-full max-w-md">
			<Card.Content class="flex flex-col gap-4">
				{#each steps as step (step.number)}
					<div class="flex items-start gap-4 p-1">
						<div class="flex-1 ml-1">
							<h3 class="font-medium text-foreground flex items-center gap-2">
								Step {step.number} : {step.title}

								{#if step.type === 'summarization'}
									<Tooltip.Provider delayDuration={300}>
										<Tooltip.Root>
											<Tooltip.Trigger
												class="text-muted-foreground hover:text-foreground"
												aria-label="More about summarization providers"
											>
												<Info class="size-4" />
											</Tooltip.Trigger>
											<Tooltip.Content class="max-w-xs">
												You can also select external AI providers like OpenAI, Claude, or Ollama for
												summary generation in settings.
											</Tooltip.Content>
										</Tooltip.Root>
									</Tooltip.Provider>
								{/if}
							</h3>
						</div>
					</div>
				{/each}
			</Card.Content>
		</Card.Root>

		<!-- CTA Section -->
		<div class="flex w-full max-w-xs flex-col gap-4">
			<Button onclick={() => onboarding.goNext()} class="h-11 w-full">Let's Go</Button>
			<div class="text-center">
				<a
					href="https://github.com/afonsojramos/muesly"
					target="_blank"
					rel="noopener noreferrer"
					class="text-xs text-muted-foreground hover:underline"
				>
					Report issues on GitHub
				</a>
			</div>
		</div>
	</div>
</OnboardingContainer>
