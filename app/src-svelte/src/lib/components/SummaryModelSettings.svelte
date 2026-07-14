<script lang="ts">
	import { onMount } from 'svelte';

	import { commands } from '$lib/bindings';
	import { config } from '$lib/stores/config.svelte';
	import { useModelConfiguration } from '$lib/hooks/use-model-configuration.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Switch } from '$lib/components/ui/switch';
	import { toast } from '$lib/toast';
	import ModelSettingsModal from './ModelSettingsModal.svelte';

	const models = useModelConfiguration();

	/** Pre-summary LLM cleanup of fillers/casing (extra generation call). */
	let transcriptCleanup = $state(false);
	let cleanupLoaded = $state(false);

	onMount(() => {
		void (async () => {
			const res = await commands.getTranscriptCleanupEnabled();
			if (res.status === 'ok') transcriptCleanup = res.data;
			cleanupLoaded = true;
		})();
	});

	async function handleCleanupToggle(enabled: boolean): Promise<void> {
		const prev = transcriptCleanup;
		transcriptCleanup = enabled;
		const res = await commands.setTranscriptCleanupEnabled(enabled);
		if (res.status === 'error') {
			transcriptCleanup = prev;
			toast.error('Failed to save cleanup setting', { description: res.error });
		}
	}
</script>

<div class="flex flex-col gap-4">
	<Card.Root>
		<Card.Header>
			<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<Card.Title id="auto-summary-label">Auto summary</Card.Title>
					<Card.Description>
						Automatically generate a summary after a meeting completes
					</Card.Description>
				</div>
				<Switch
					checked={config.isAutoSummary}
					aria-labelledby="auto-summary-label"
					onCheckedChange={config.toggleIsAutoSummary}
				/>
			</div>
		</Card.Header>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<Card.Title id="summary-cleanup-label">Clean transcript before summarizing</Card.Title>
					<Card.Description>
						Run an extra AI pass to fix fillers, casing, and punctuation before the summary. Adds
						latency (and cost for cloud models). Off by default.
					</Card.Description>
				</div>
				<Switch
					checked={transcriptCleanup}
					disabled={!cleanupLoaded}
					aria-labelledby="summary-cleanup-label"
					onCheckedChange={(v) => void handleCleanupToggle(v)}
				/>
			</div>
		</Card.Header>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Summary model configuration</Card.Title>
			<Card.Description>
				Configure the AI model used for generating meeting summaries.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<ModelSettingsModal
				modelConfig={models.modelConfig}
				setModelConfig={models.setModelConfig}
				onSave={models.handleSaveModelConfig}
			/>
		</Card.Content>
	</Card.Root>
</div>
