<script lang="ts">
	import { config } from '$lib/stores/config.svelte';
	import { useModelConfiguration } from '$lib/hooks/use-model-configuration.svelte';
	import Switch from '$lib/ui/switch.svelte';
	import ModelSettingsModal from './ModelSettingsModal.svelte';

	const models = useModelConfiguration();
</script>

<div class="flex flex-col gap-4">
	<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
		<div class="flex items-center justify-between">
			<div>
				<h3 class="mb-2 text-lg font-semibold">Auto Summary</h3>
				<p class="text-sm text-muted-foreground">
					Automatically generate a summary after a meeting completes
				</p>
			</div>
			<Switch checked={config.isAutoSummary} onCheckedChange={config.toggleIsAutoSummary} />
		</div>
	</div>

	<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
		<h3 class="mb-4 text-lg font-semibold">Summary Model Configuration</h3>
		<p class="mb-6 text-sm text-muted-foreground">
			Configure the AI model used for generating meeting summaries.
		</p>

		<ModelSettingsModal
			modelConfig={models.modelConfig}
			setModelConfig={models.setModelConfig}
			onSave={models.handleSaveModelConfig}
		/>
	</div>
</div>
