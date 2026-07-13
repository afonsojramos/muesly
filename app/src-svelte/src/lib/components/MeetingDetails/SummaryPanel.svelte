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
	import SummaryUpdaterButtonGroup from './SummaryUpdaterButtonGroup.svelte';

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

	export function getSummaryMarkdown(): string {
		return summaryView?.getMarkdown() ?? '';
	}

	const isSummaryLoading = $derived(
		summaryStatus === 'processing' ||
			summaryStatus === 'cleanup' ||
			summaryStatus === 'summarizing' ||
			summaryStatus === 'regenerating',
	);

	const hasModel = $derived(modelConfig.provider !== null && modelConfig.model !== null);
</script>

<div class="flex flex-1 min-w-0 flex-col overflow-hidden bg-background">
	<div class="px-8 py-2">
		{#if aiSummary && !isSummaryLoading}
			<div class="flex w-full items-center gap-2 pt-0">
				<div class="flex-shrink-0">
					<SummaryGeneratorButtonGroup
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
						hasTranscripts={transcripts.length > 0}
						{isModelConfigLoading}
						{onOpenModelSettings}
					/>
				</div>
				<div class="flex-shrink-0">
					<SummaryUpdaterButtonGroup onCopy={onCopySummary} hasSummary={!!aiSummary} />
				</div>
			</div>
		{/if}
	</div>

	{#if isSummaryLoading}
		<div class="flex h-full flex-col">
			<div class="flex items-center justify-center pb-4 pt-8">
				<SummaryGeneratorButtonGroup
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
					hasTranscripts={transcripts.length > 0}
					{isModelConfigLoading}
					{onOpenModelSettings}
				/>
			</div>
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
			<div class="flex items-center justify-center pb-4 pt-8">
				<SummaryGeneratorButtonGroup
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
					hasTranscripts={transcripts.length > 0}
					{isModelConfigLoading}
					{onOpenModelSettings}
				/>
			</div>
			<EmptyStateSummary
				onGenerate={() => void onGenerateSummary(customPrompt)}
				{hasModel}
				isGenerating={isSummaryLoading}
			/>
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
