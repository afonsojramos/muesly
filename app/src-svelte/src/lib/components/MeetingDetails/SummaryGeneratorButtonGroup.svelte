<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import AlertTriangleIcon from '@lucide/svelte/icons/alert-triangle';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import SquareIcon from '@lucide/svelte/icons/square';

	import type { ModelConfig } from '$lib/services/config';
	import type { BuiltInModelInfo } from '$lib/ai/builtin-ai';
	import type { SummaryStatus } from '$lib/hooks/use-summary-generation.svelte';
	import type { Template } from '$lib/hooks/use-templates.svelte';
	import { AUTO_SUMMARY_LANGUAGE, SUMMARY_LANGUAGES } from '$lib/summary-languages';
	import { summaryLanguage } from '$lib/stores/summary-language.svelte';
	import { config } from '$lib/stores/config.svelte';
	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import { isOllamaNotInstalledError } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import ModelSettingsModal from '$lib/components/ModelSettingsModal.svelte';

	interface Props {
		modelConfig: ModelConfig;
		setModelConfig: (config: ModelConfig) => void;
		onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
		onGenerateSummary: (customPrompt: string) => Promise<void>;
		onStopGeneration: () => void;
		customPrompt: string;
		summaryStatus: SummaryStatus;
		availableTemplates: Template[];
		selectedTemplate: string;
		onTemplateSelect: (templateId: string, templateName: string) => void;
		hasTranscripts?: boolean;
		isModelConfigLoading?: boolean;
		/** Register a callback the parent can call to open the settings dialog. */
		onOpenModelSettings?: (openFn: () => void) => void;
	}

	let {
		modelConfig,
		setModelConfig,
		onSaveModelConfig,
		onGenerateSummary,
		onStopGeneration,
		customPrompt,
		summaryStatus,
		availableTemplates,
		selectedTemplate,
		onTemplateSelect,
		hasTranscripts = true,
		isModelConfigLoading = false,
		onOpenModelSettings
	}: Props = $props();

	let isCheckingModels = $state(false);
	let settingsDialogOpen = $state(false);

	// Register our open function with the parent (mirrors the React ref pattern).
	$effect(() => {
		if (onOpenModelSettings) {
			onOpenModelSettings(() => {
				settingsDialogOpen = true;
			});
		}
	});

	const isGenerating = $derived(
		summaryStatus === 'processing' ||
			summaryStatus === 'summarizing' ||
			summaryStatus === 'regenerating'
	);

	async function checkBuiltInAIModelsAndGenerate(): Promise<void> {
		isCheckingModels = true;
		try {
			const selectedModel = modelConfig.model;
			if (!selectedModel) {
				toast.error('No built-in AI model selected', {
					description: 'Please select a model in settings',
					duration: 5000
				});
				settingsDialogOpen = true;
				return;
			}

			const isReady = await invoke<boolean>('builtin_ai_is_model_ready', {
				modelName: selectedModel,
				refresh: true
			});

			if (isReady) {
				void onGenerateSummary(customPrompt);
				return;
			}

			const modelInfo = await invoke<BuiltInModelInfo | null>('builtin_ai_get_model_info', {
				modelName: selectedModel
			});

			if (!modelInfo) {
				toast.error('Model not found', {
					description: `Could not find information for model: ${selectedModel}`,
					duration: 5000
				});
				settingsDialogOpen = true;
				return;
			}

			const status = modelInfo.status;
			if (status.type === 'downloading') {
				toast.info('Model download in progress', {
					description: `${selectedModel} is downloading (${status.progress}%). Please wait until download completes.`,
					duration: 5000
				});
				return;
			}
			if (status.type === 'not_downloaded') {
				toast.error('Model not downloaded', {
					description: `${selectedModel} needs to be downloaded before use. Opening model settings...`,
					duration: 5000
				});
				settingsDialogOpen = true;
				return;
			}
			if (status.type === 'corrupted') {
				toast.error('Model file corrupted', {
					description: `${selectedModel} file is corrupted. Please delete and re-download.`,
					duration: 7000
				});
				settingsDialogOpen = true;
				return;
			}
			if (status.type === 'error') {
				toast.error('Model error', {
					description: status.Error || 'An error occurred with the model',
					duration: 5000
				});
				settingsDialogOpen = true;
				return;
			}

			toast.error('Model not available', {
				description: 'The selected model is not ready for use',
				duration: 5000
			});
			settingsDialogOpen = true;
		} catch (error) {
			console.error('Error checking built-in AI models:', error);
			toast.error('Failed to check model status', {
				description: error instanceof Error ? error.message : String(error),
				duration: 5000
			});
		} finally {
			isCheckingModels = false;
		}
	}

	async function checkOllamaModelsAndGenerate(): Promise<void> {
		if (modelConfig.provider === 'builtin-ai') {
			await checkBuiltInAIModelsAndGenerate();
			return;
		}

		if (modelConfig.provider !== 'ollama') {
			void onGenerateSummary(customPrompt);
			return;
		}

		isCheckingModels = true;
		try {
			const endpoint = modelConfig.ollamaEndpoint || null;
			const models = (await invoke('get_ollama_models', { endpoint })) as unknown[];

			if (!models || models.length === 0) {
				toast.error('No Ollama models found. Please download gemma2:2b from Model Settings.', {
					duration: 5000
				});
				settingsDialogOpen = true;
				return;
			}

			void onGenerateSummary(customPrompt);
		} catch (error) {
			console.error('Error checking Ollama models:', error);
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (isOllamaNotInstalledError(errorMessage)) {
				toast.error('Ollama is not installed', {
					description: 'Please download and install Ollama to use local models.',
					duration: 7000,
					action: {
						label: 'Download',
						onClick: () =>
							invoke('open_external_url', { url: 'https://ollama.com/download' }).catch(() => {})
					}
				});
			} else {
				toast.error(
					'Failed to check Ollama models. Please check if Ollama is running and download a model.',
					{ duration: 5000 }
				);
			}
			settingsDialogOpen = true;
		} finally {
			isCheckingModels = false;
		}
	}

	const templateItems = $derived(
		availableTemplates.map((t) => ({
			value: t.id,
			label: t.name,
			checked: t.id === selectedTemplate
		}))
	);

	function handleTemplateSelect(value: string): void {
		const template = availableTemplates.find((t) => t.id === value);
		if (template) onTemplateSelect(template.id, template.name);
	}

	const languageItems = $derived(
		[{ code: AUTO_SUMMARY_LANGUAGE, name: 'Automatic (English)' }, ...SUMMARY_LANGUAGES].map(
			(l) => ({
				value: l.code,
				label: l.name,
				checked: l.code === summaryLanguage.preferred
			})
		)
	);

	function handleLanguageSelect(value: string): void {
		summaryLanguage.set(value);
	}

	// Whisper's "auto-translate" stores an English transcript, so a non-English
	// summary is translated out of English and loses original-language nuance.
	const showTranslateFidelityNote = $derived(
		config.selectedLanguage === 'auto-translate' &&
			summaryLanguage.preferred !== AUTO_SUMMARY_LANGUAGE &&
			summaryLanguage.preferred !== 'en'
	);
</script>

{#if hasTranscripts}
	<div class="flex items-center gap-1">
		{#if isGenerating}
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="destructive"
								size="sm"
								class="xl:px-4"
								aria-label="Stop summary generation"
								onclick={() => {
									Analytics.trackButtonClick('stop_summary_generation', 'meeting_details');
									onStopGeneration();
								}}
							>
								<SquareIcon fill="currentColor" data-icon="inline-start" />
								<span class="hidden lg:inline xl:inline">Stop</span>
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Stop summary generation</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		{:else}
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="accent"
								size="sm"
								class="rounded-full xl:px-4"
								disabled={isCheckingModels || isModelConfigLoading}
								aria-label="Enhance notes with AI"
								onclick={() => {
									Analytics.trackButtonClick('generate_summary', 'meeting_details');
									void checkOllamaModelsAndGenerate();
								}}
							>
								{#if isCheckingModels || isModelConfigLoading}
									<Loader2Icon class="animate-spin" />
									<span class="hidden xl:inline">Processing...</span>
								{:else}
									<SparklesIcon />
									<span class="hidden lg:inline xl:inline">Enhance notes</span>
								{/if}
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>
						{isModelConfigLoading
							? 'Loading model configuration...'
							: isCheckingModels
								? 'Checking models...'
								: 'Enhance notes with AI'}
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		{/if}

		<Dialog.Root bind:open={settingsDialogOpen}>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="text-muted-foreground hover:text-foreground"
						aria-label="Summary settings"
						title="Summary Settings"
					>
						<SettingsIcon data-icon="inline-start" />
						<span class="hidden lg:inline">AI Model</span>
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="sm:max-w-lg">
				<Dialog.Title class="sr-only">Model Settings</Dialog.Title>
				<ModelSettingsModal
					{modelConfig}
					{setModelConfig}
					onSave={async (config) => {
						await onSaveModelConfig(config);
						settingsDialogOpen = false;
					}}
				/>
			</Dialog.Content>
		</Dialog.Root>

		{#if availableTemplates.length > 0}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="text-muted-foreground hover:text-foreground"
							aria-label="Select summary template"
							title="Select summary template"
						>
							<FileTextIcon data-icon="inline-start" />
							<span class="hidden lg:inline">Template</span>
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="max-h-72 overflow-y-auto">
					<DropdownMenu.Group>
						{#each templateItems as item (item.value)}
							<DropdownMenu.CheckboxItem
								checked={item.checked}
								onSelect={() => handleTemplateSelect(item.value)}
							>
								{item.label}
							</DropdownMenu.CheckboxItem>
						{/each}
					</DropdownMenu.Group>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="text-muted-foreground hover:text-foreground"
						aria-label="Select summary language"
						title="Select summary language"
					>
						<LanguagesIcon data-icon="inline-start" />
						<span class="hidden lg:inline">Language</span>
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="max-h-72 overflow-y-auto">
				<DropdownMenu.Group>
					{#each languageItems as item (item.value)}
						<DropdownMenu.CheckboxItem
							checked={item.checked}
							onSelect={() => handleLanguageSelect(item.value)}
						>
							{item.label}
						</DropdownMenu.CheckboxItem>
					{/each}
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		{#if showTranslateFidelityNote}
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<span {...props} class="flex items-center text-warning">
								<AlertTriangleIcon class="size-4" />
								<span class="sr-only">Translation fidelity warning</span>
							</span>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-xs">
						Transcription is set to translate audio to English, so the transcript is stored in
						English. A non-English summary is translated from that English text and may lose
						original-language nuance. For best fidelity, set the transcription language to a specific
						language or Auto Detect (Original Language).
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		{/if}
	</div>
{/if}
