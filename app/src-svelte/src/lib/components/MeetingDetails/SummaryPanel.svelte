<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2';

	import type { Summary } from '$lib/types';
	import type { ModelConfig } from '$lib/services/config';
	import type { SummaryStatus } from '$lib/hooks/use-summary-generation.svelte';
	import type { Template } from '$lib/hooks/use-templates.svelte';
	import { Analytics } from '$lib/analytics';
	import { Button } from '$lib/components/ui/button';
	import EmptyStateSummary from '$lib/components/EmptyStateSummary.svelte';
	import SummaryView from '$lib/components/SummaryView.svelte';
	import SummaryGeneratorButtonGroup from './SummaryGeneratorButtonGroup.svelte';

	interface Props {
		onCopySummary: () => Promise<void>;
		onOpenFolder: () => Promise<void>;
		aiSummary: Summary | null;
		summaryStatus: SummaryStatus;
		transcripts: unknown[];
		modelConfig: ModelConfig;
		setModelConfig: (config: ModelConfig) => void;
		onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
		onGenerateSummary: (customPrompt: string) => Promise<void>;
		onStopGeneration: () => void;
		customPrompt: string;
		onSaveSummary: (summary: { markdown: string }) => Promise<void>;
		summaryError: string | null;
		onRegenerateSummary: () => Promise<void>;
		availableTemplates: Template[];
		selectedTemplate: string;
		onTemplateSelect: (templateId: string, templateName: string) => void;
		isModelConfigLoading?: boolean;
		onOpenModelSettings?: (openFn: () => void) => void;
		onTimestampClick?: (seconds: number) => void;
	}

	let {
		onCopySummary,
		onOpenFolder,
		aiSummary,
		summaryStatus,
		transcripts,
		modelConfig,
		setModelConfig,
		onSaveModelConfig,
		onGenerateSummary,
		onStopGeneration,
		customPrompt,
		onSaveSummary,
		summaryError,
		onRegenerateSummary,
		availableTemplates,
		selectedTemplate,
		onTemplateSelect,
		isModelConfigLoading = false,
		onOpenModelSettings,
		onTimestampClick,
	}: Props = $props();

	let summaryView = $state<ReturnType<typeof SummaryView>>();
	let summaryControls = $state<ReturnType<typeof SummaryGeneratorButtonGroup>>();

	export function getSummaryMarkdown(): string {
		return summaryView?.getMarkdown() ?? '';
	}

	export async function triggerSummaryAction(): Promise<void> {
		await summaryControls?.triggerPrimaryAction();
	}

	export function openSummarySettings(): void {
		summaryControls?.openSettings();
	}

	const isSummaryLoading = $derived(
		summaryStatus === 'processing' ||
			summaryStatus === 'cleanup' ||
			summaryStatus === 'summarizing' ||
			summaryStatus === 'regenerating',
	);

	// Truthiness, not `!== null`: `model` is typed `string` and defaults to '', so
	// the null check never fired and hasModel was effectively always true.
	const hasModel = $derived(!!modelConfig.provider && !!modelConfig.model);
</script>

<!-- Keep one headless controller mounted for model validation/settings. Its
     visible actions live in the meeting's three-dot menu. -->
<SummaryGeneratorButtonGroup
	bind:this={summaryControls}
	{modelConfig}
	{setModelConfig}
	{onSaveModelConfig}
	{onGenerateSummary}
	{onStopGeneration}
	{customPrompt}
	{summaryStatus}
	{availableTemplates}
	{selectedTemplate}
	{onTemplateSelect}
	hasTranscripts={false}
	{isModelConfigLoading}
	{onOpenModelSettings}
/>

<div class="flex flex-1 min-w-0 flex-col overflow-hidden bg-background">
	{#if isSummaryLoading}
		<div class="flex h-full flex-col">
			<div class="flex flex-1 items-center justify-center">
				<div class="text-center">
					<Loader2Icon class="mx-auto mb-4 size-12 animate-spin text-brand" />
					<p class="text-muted-foreground">
						{summaryStatus === 'cleanup' ? 'Cleaning transcript…' : 'Generating AI Summary...'}
					</p>
				</div>
			</div>
		</div>
	{:else if !aiSummary}
		<div class="flex h-full flex-col">
			<EmptyStateSummary
				onGenerate={() => void onGenerateSummary(customPrompt)}
				{hasModel}
				isGenerating={isSummaryLoading}
			/>
			{#if summaryError}
				<!-- Keep the failure visible in the empty state; previously the error
				     only flashed as a toast and the panel fell back to blank. -->
				<p class="px-8 pb-8 text-center text-sm text-destructive">{summaryError}</p>
			{/if}
		</div>
	{:else}
		<!-- Show the summary whenever one exists — gating on transcripts hid a valid
		     summary when its rows failed to load or were deleted. -->
		<div class="min-h-0 flex-1 overflow-y-auto">
			<div class="w-full px-8 py-4">
				<SummaryView
					bind:this={summaryView}
					summaryData={aiSummary}
					status={summaryStatus}
					error={summaryError}
					editable={true}
					onSave={onSaveSummary}
					{onTimestampClick}
				/>
				{#if summaryError}
					<div class="mt-4">
						<Button
							variant="link"
							size="sm"
							class="h-auto p-0 text-brand"
							onclick={() => {
								Analytics.trackButtonClick('regenerate_summary', 'meeting_details');
								void onRegenerateSummary();
							}}
						>
							Regenerate summary
						</Button>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
