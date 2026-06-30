<script lang="ts">
	import { config } from '$lib/stores/config.svelte';
	import { useModelConfiguration } from '$lib/hooks/use-model-configuration.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Switch } from '$lib/components/ui/switch';
	import ModelSettingsModal from './ModelSettingsModal.svelte';

	const models = useModelConfiguration();
</script>

<div class="flex flex-col gap-4">
	<Card.Root>
		<Card.Header>
			<div class="flex items-center justify-between">
				<div>
					<Card.Title>Auto Summary</Card.Title>
					<Card.Description>
						Automatically generate a summary after a meeting completes
					</Card.Description>
				</div>
				<Switch checked={config.isAutoSummary} onCheckedChange={config.toggleIsAutoSummary} />
			</div>
		</Card.Header>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Summary Model Configuration</Card.Title>
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
