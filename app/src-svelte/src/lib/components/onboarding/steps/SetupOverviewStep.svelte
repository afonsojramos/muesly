<script lang="ts">
	import { Info } from '@lucide/svelte';
	import Button from '$lib/ui/button.svelte';
	import Tooltip from '$lib/ui/tooltip.svelte';
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
	<div class="flex flex-col items-center space-y-10">
		<!-- Steps Card -->
		<div class="w-full max-w-md bg-card rounded-lg border border-border p-4">
			<div class="space-y-4">
				{#each steps as step (step.number)}
					<div class="flex items-start gap-4 p-1">
						<div class="flex-1 ml-1">
							<h3 class="font-medium text-foreground flex items-center gap-2">
								Step {step.number} : {step.title}

								{#if step.type === 'summarization'}
									<Tooltip class="max-w-xs text-sm">
										{#snippet trigger()}
											<span class="text-muted-foreground hover:text-foreground">
												<Info class="w-4 h-4" />
											</span>
										{/snippet}
										{#snippet content()}
											You can also select external AI providers like OpenAI, Claude, or Ollama for
											summary generation in settings.
										{/snippet}
									</Tooltip>
								{/if}
							</h3>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- CTA Section -->
		<div class="w-full max-w-xs space-y-4">
			<Button onclick={() => onboarding.goNext()} class="w-full h-11">Let's Go</Button>
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
