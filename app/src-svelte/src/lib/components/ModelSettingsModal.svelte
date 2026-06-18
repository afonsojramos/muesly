<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import {
		CheckCircle2,
		ChevronDown,
		ChevronUp,
		Download,
		ExternalLink,
		RefreshCw,
		XCircle
	} from '@lucide/svelte';

	import type { OllamaModel } from '$lib/stores/config.svelte';
	import { configService, type ModelConfig } from '$lib/services/config';
	import { ollamaDownload } from '$lib/stores/ollama-download.svelte';
	import Alert from '$lib/ui/alert.svelte';
	import Button from '$lib/ui/button.svelte';
	import Combobox from '$lib/ui/combobox.svelte';
	import Input from '$lib/ui/input.svelte';
	import Label from '$lib/ui/label.svelte';
	import ScrollArea from '$lib/ui/scroll-area.svelte';
	import Select from '$lib/ui/select.svelte';
	import BuiltInModelManager from './BuiltInModelManager.svelte';
	import { toast } from '$lib/toast';
	import { cn, isOllamaNotInstalledError } from '$lib/utils';

	interface Props {
		modelConfig: ModelConfig;
		setModelConfig: (config: ModelConfig) => void;
		onSave: (config: ModelConfig) => void;
	}

	let { modelConfig, setModelConfig, onSave }: Props = $props();

	// Local/offline providers plus cloud (BYOK) providers. Cloud providers send the
	// transcript off-device and need an API key (saved per-provider by the backend).
	const AVAILABLE_PROVIDERS = [
		'builtin-ai',
		'ollama',
		'custom-openai',
		'claude',
		'groq',
		'grok',
		'openrouter'
	] as const;
	type AvailableProvider = (typeof AVAILABLE_PROVIDERS)[number];

	function isAvailableProvider(value: string | undefined): value is AvailableProvider {
		return value !== undefined && (AVAILABLE_PROVIDERS as readonly string[]).includes(value);
	}

	const providerItems = [
		{ value: 'builtin-ai', label: 'Built-in AI (Offline, No API needed)' },
		{ value: 'ollama', label: 'Ollama (Local)' },
		{ value: 'custom-openai', label: 'Custom Server (OpenAI)' },
		{ value: 'claude', label: 'Claude — Anthropic (Cloud)' },
		{ value: 'groq', label: 'Groq (Cloud)' },
		{ value: 'grok', label: 'xAI (Grok)' },
		{ value: 'openrouter', label: 'OpenRouter (Cloud)' }
	];

	// Cloud (BYOK) provider metadata for the key + model inputs and privacy notice.
	const CLOUD_PROVIDERS: Record<
		string,
		{ name: string; modelPlaceholder: string; keyUrl: string }
	> = {
		claude: {
			name: 'Claude (Anthropic)',
			modelPlaceholder: 'e.g. claude-sonnet-4-5',
			keyUrl: 'https://console.anthropic.com/settings/keys'
		},
		groq: {
			name: 'Groq',
			modelPlaceholder: 'e.g. llama-3.3-70b-versatile',
			keyUrl: 'https://console.groq.com/keys'
		},
		grok: {
			name: 'xAI (Grok)',
			modelPlaceholder: 'e.g. grok-3-mini',
			keyUrl: 'https://console.x.ai'
		},
		openrouter: {
			name: 'OpenRouter',
			modelPlaceholder: 'e.g. anthropic/claude-3.5-sonnet',
			keyUrl: 'https://openrouter.ai/keys'
		}
	};

	const cloudProvider = $derived(CLOUD_PROVIDERS[modelConfig.provider]);

	const RECOMMENDED_MODEL = 'gemma3:1b';

	// Ollama state.
	let models = $state<OllamaModel[]>([]);
	let error = $state('');
	let isLoadingOllama = $state(false);
	let hasAutoFetched = $state(false);
	let ollamaNotInstalled = $state(false);
	let searchQuery = $state('');
	let isEndpointSectionCollapsed = $state(true);
	// svelte-ignore state_referenced_locally
	let ollamaEndpoint = $state(modelConfig.ollamaEndpoint ?? '');
	// svelte-ignore state_referenced_locally
	let lastFetchedEndpoint = $state(modelConfig.ollamaEndpoint ?? '');
	let endpointValidationState = $state<'valid' | 'invalid' | 'none'>('none');
	// svelte-ignore state_referenced_locally
	let lastPropEndpoint = $state(modelConfig.ollamaEndpoint ?? '');
	const modelsCache = new Map<string, OllamaModel[]>();

	// Custom OpenAI state.
	// svelte-ignore state_referenced_locally
	let customOpenAIEndpoint = $state(modelConfig.customOpenAIEndpoint ?? '');
	// svelte-ignore state_referenced_locally
	let customOpenAIModel = $state(modelConfig.customOpenAIModel ?? '');
	// svelte-ignore state_referenced_locally
	let customOpenAIApiKey = $state(modelConfig.customOpenAIApiKey ?? '');
	// svelte-ignore state_referenced_locally
	let customMaxTokens = $state(modelConfig.maxTokens?.toString() ?? '');
	// svelte-ignore state_referenced_locally
	let customTemperature = $state(modelConfig.temperature?.toString() ?? '');
	// svelte-ignore state_referenced_locally
	let customTopP = $state(modelConfig.topP?.toString() ?? '');
	let isCustomOpenAIAdvancedOpen = $state(false);
	let isTestingConnection = $state(false);

	const isBrowser = typeof window !== 'undefined';

	function readProviderModelMap(): Record<string, string> {
		if (!isBrowser) return {};
		try {
			return JSON.parse(localStorage.getItem('providerModelMap') || '{}');
		} catch {
			return {};
		}
	}

	function writeProviderModelMap(map: Record<string, string>): void {
		if (!isBrowser) return;
		localStorage.setItem('providerModelMap', JSON.stringify(map));
	}

	function validateOllamaEndpoint(url: string): boolean {
		if (!url.trim()) return true; // Empty is valid (uses default).
		try {
			const parsed = new URL(url);
			return parsed.protocol === 'http:' || parsed.protocol === 'https:';
		} catch {
			return false;
		}
	}

	const ollamaEndpointChanged = $derived(
		modelConfig.provider === 'ollama' && ollamaEndpoint.trim() !== lastFetchedEndpoint.trim()
	);

	const isCustomOpenAIInvalid = $derived(
		modelConfig.provider === 'custom-openai' &&
			(!customOpenAIEndpoint.trim() || !customOpenAIModel.trim())
	);

	// Cloud providers need both an API key and a model name before saving.
	const isCloudInvalid = $derived(
		!!cloudProvider && (!modelConfig.apiKey?.trim() || !modelConfig.model.trim())
	);

	const isDoneDisabled = $derived(
		(modelConfig.provider === 'ollama' && ollamaEndpointChanged) ||
			isCustomOpenAIInvalid ||
			isCloudInvalid
	);

	const filteredModels = $derived(
		models.filter((model) => {
			if (!searchQuery.trim()) return true;
			const query = searchQuery.toLowerCase();
			const loadedText = modelConfig.model === model.name ? 'loaded' : '';
			return (
				model.name.toLowerCase().includes(query) ||
				model.size.toLowerCase().includes(query) ||
				loadedText.includes(query)
			);
		})
	);

	const ollamaComboItems = $derived(models.map((m) => ({ label: m.name, value: m.name })));

	// Debounced endpoint URL validation with visual feedback.
	$effect(() => {
		const value = ollamaEndpoint;
		const timer = setTimeout(() => {
			const trimmed = value.trim();
			if (!trimmed) endpointValidationState = 'none';
			else endpointValidationState = validateOllamaEndpoint(trimmed) ? 'valid' : 'invalid';
		}, 500);
		return () => clearTimeout(timer);
	});

	// Sync the endpoint input when the parent config's endpoint changes (e.g. async load),
	// without clobbering in-progress user edits.
	$effect(() => {
		const next = modelConfig.ollamaEndpoint ?? '';
		if (next !== lastPropEndpoint) {
			lastPropEndpoint = next;
			ollamaEndpoint = next;
		}
	});

	// Clear Ollama state whenever we leave the Ollama provider.
	$effect(() => {
		if (modelConfig.provider !== 'ollama') {
			hasAutoFetched = false;
			models = [];
			error = '';
			ollamaNotInstalled = false;
		}
	});

	// Auto-fetch Ollama models the first time the provider becomes Ollama.
	$effect(() => {
		if (modelConfig.provider === 'ollama' && !hasAutoFetched) {
			hasAutoFetched = true;
			void fetchOllamaModels(true);
		}
	});

	// Keep custom-OpenAI inputs in sync with the parent config, but only when the
	// incoming config actually changes — so unrelated effect re-runs never clobber
	// in-progress edits.
	let lastCustomSnapshot = $state('');
	$effect(() => {
		if (modelConfig.provider !== 'custom-openai') return;
		const snapshot = JSON.stringify([
			modelConfig.customOpenAIEndpoint,
			modelConfig.customOpenAIModel,
			modelConfig.customOpenAIApiKey,
			modelConfig.maxTokens,
			modelConfig.temperature,
			modelConfig.topP
		]);
		if (snapshot === lastCustomSnapshot) return;
		lastCustomSnapshot = snapshot;
		customOpenAIEndpoint = modelConfig.customOpenAIEndpoint ?? '';
		customOpenAIModel = modelConfig.customOpenAIModel ?? '';
		customOpenAIApiKey = modelConfig.customOpenAIApiKey ?? '';
		customMaxTokens = modelConfig.maxTokens?.toString() ?? '';
		customTemperature = modelConfig.temperature?.toString() ?? '';
		customTopP = modelConfig.topP?.toString() ?? '';
	});

	// Refresh the model list whenever a download completes.
	let prevDownloading = new Set<string>();
	$effect(() => {
		const current = new Set(ollamaDownload.downloadingModels);
		for (const modelName of prevDownloading) {
			if (!current.has(modelName)) {
				void fetchOllamaModels(true);
				break;
			}
		}
		prevDownloading = current;
	});

	async function fetchOllamaModels(silent = false): Promise<void> {
		const trimmedEndpoint = ollamaEndpoint.trim();

		if (trimmedEndpoint && !validateOllamaEndpoint(trimmedEndpoint)) {
			const errorMsg = 'Invalid Ollama endpoint URL. Must start with http:// or https://';
			error = errorMsg;
			if (!silent) toast.error(errorMsg);
			return;
		}

		isLoadingOllama = true;
		error = '';

		try {
			const endpoint = trimmedEndpoint || null;
			const list = await invoke<OllamaModel[]>('get_ollama_models', { endpoint });
			models = list;
			lastFetchedEndpoint = trimmedEndpoint;
			modelsCache.set(trimmedEndpoint, list);
			ollamaNotInstalled = false;
			restoreCachedModel();
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : 'Failed to load Ollama models';
			error = errorMsg;
			ollamaNotInstalled = isOllamaNotInstalledError(errorMsg);
			if (!silent) toast.error(errorMsg);
			console.error('Error loading models:', err);
		} finally {
			isLoadingOllama = false;
		}
	}

	// When a fresh model list arrives, restore the user's cached choice if the
	// current selection is no longer valid.
	function restoreCachedModel(): void {
		const names = models.map((m) => m.name);
		if (names.length === 0) return;
		if (modelConfig.model && names.includes(modelConfig.model)) return;
		const cached = readProviderModelMap()[modelConfig.provider];
		if (cached && names.includes(cached)) {
			setModelConfig({ ...modelConfig, model: cached });
		}
	}

	function handleEndpointInput(value: string): void {
		ollamaEndpoint = value;
		// Clear stale models/errors as soon as the endpoint diverges from the last fetch.
		if (value.trim() !== lastFetchedEndpoint.trim()) {
			const cached = modelsCache.get(value.trim());
			if (cached && cached.length > 0) {
				models = cached;
				lastFetchedEndpoint = value.trim();
				error = '';
			} else {
				hasAutoFetched = true; // Manual fetch only from here on.
				models = [];
				error = '';
			}
		}
	}

	async function handleProviderChange(value: string[]): Promise<void> {
		const provider: AvailableProvider = isAvailableProvider(value[0]) ? value[0] : 'ollama';
		error = '';

		const map = readProviderModelMap();
		if (modelConfig.model) {
			map[modelConfig.provider] = modelConfig.model;
			writeProviderModelMap(map);
		}

		const providerModels = provider === 'ollama' ? models.map((m) => m.name) : [];
		const saved = map[provider];
		const defaultModel = providerModels[0] ?? '';
		const model = saved && providerModels.includes(saved) ? saved : defaultModel;

		setModelConfig({ ...modelConfig, provider, model });

		if (provider === 'custom-openai') {
			await loadCustomConfig();
		}
	}

	async function loadCustomConfig(): Promise<void> {
		try {
			const config = await configService.getCustomOpenAIConfig();
			if (config) {
				customOpenAIEndpoint = config.endpoint ?? '';
				customOpenAIModel = config.model ?? '';
				customOpenAIApiKey = config.apiKey ?? '';
				customMaxTokens = config.maxTokens?.toString() ?? '';
				customTemperature = config.temperature?.toString() ?? '';
				customTopP = config.topP?.toString() ?? '';
			}
		} catch (err) {
			console.error('Failed to load custom OpenAI config:', err);
		}
	}

	function handleOllamaModelSelect(value: string[]): void {
		const model = value[0];
		if (model) setModelConfig({ ...modelConfig, model });
	}

	async function downloadRecommendedModel(): Promise<void> {
		if (ollamaDownload.isDownloading(RECOMMENDED_MODEL)) {
			toast.info(`${RECOMMENDED_MODEL} is already downloading`, {
				description: `Progress: ${Math.round(ollamaDownload.getProgress(RECOMMENDED_MODEL) ?? 0)}%`
			});
			return;
		}

		try {
			const endpoint = ollamaEndpoint.trim() || null;
			await invoke('pull_ollama_model', { modelName: RECOMMENDED_MODEL, endpoint });
			await fetchOllamaModels(true);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : 'Failed to download model';
			console.error('Error downloading model:', err);
			if (isOllamaNotInstalledError(errorMsg)) {
				toast.error('Ollama is not installed', {
					description: 'Please download and install Ollama before downloading models.',
					duration: 7000
				});
				ollamaNotInstalled = true;
			}
		}
	}

	async function testCustomOpenAIConnection(): Promise<void> {
		if (!customOpenAIEndpoint.trim() || !customOpenAIModel.trim()) {
			toast.error('Please enter endpoint URL and model name first');
			return;
		}

		isTestingConnection = true;
		try {
			const result = await configService.testCustomOpenAIConnection(
				customOpenAIEndpoint.trim(),
				customOpenAIApiKey.trim() || null,
				customOpenAIModel.trim()
			);
			toast.success(result.message || 'Connection successful!');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			isTestingConnection = false;
		}
	}

	async function handleSave(): Promise<void> {
		if (modelConfig.provider === 'custom-openai') {
			try {
				await configService.saveCustomOpenAIConfig({
					endpoint: customOpenAIEndpoint.trim(),
					apiKey: customOpenAIApiKey.trim() || null,
					model: customOpenAIModel.trim(),
					maxTokens: customMaxTokens ? parseInt(customMaxTokens, 10) : null,
					temperature: customTemperature ? parseFloat(customTemperature) : null,
					topP: customTopP ? parseFloat(customTopP) : null
				});
			} catch (err) {
				console.error('Failed to save custom OpenAI config:', err);
				toast.error('Failed to save custom OpenAI configuration');
				return;
			}
		}

		const isCustom = modelConfig.provider === 'custom-openai';
		const updated: ModelConfig = {
			...modelConfig,
			ollamaEndpoint:
				modelConfig.provider === 'ollama'
					? ollamaEndpoint.trim() || null
					: (modelConfig.ollamaEndpoint ?? null),
			customOpenAIEndpoint: isCustom ? customOpenAIEndpoint.trim() : null,
			customOpenAIModel: isCustom ? customOpenAIModel.trim() : null,
			customOpenAIApiKey: isCustom && customOpenAIApiKey.trim() ? customOpenAIApiKey.trim() : null,
			maxTokens: isCustom && customMaxTokens ? parseInt(customMaxTokens, 10) : null,
			temperature: isCustom && customTemperature ? parseFloat(customTemperature) : null,
			topP: isCustom && customTopP ? parseFloat(customTopP) : null,
			model: isCustom ? customOpenAIModel.trim() : modelConfig.model
		};

		setModelConfig(updated);

		if (updated.model) {
			const map = readProviderModelMap();
			map[updated.provider] = updated.model;
			writeProviderModelMap(map);
		}

		onSave(updated);
	}
</script>

<div>
	<div class="mb-4 flex items-center justify-between">
		<h3 class="text-lg font-semibold">Model Settings</h3>
	</div>

	<div class="space-y-4">
		<div>
			<Label class="mb-1 block">Summarization Model</Label>
			<div class="flex gap-2">
				<Select
					items={providerItems}
					value={[modelConfig.provider]}
					placeholder="Select provider"
					onValueChange={handleProviderChange}
				/>

				{#if modelConfig.provider === 'ollama'}
					<Combobox
						items={ollamaComboItems}
						value={modelConfig.model ? [modelConfig.model] : []}
						placeholder="Select model…"
						class="max-w-[240px]"
						onValueChange={handleOllamaModelSelect}
					/>
				{/if}
			</div>
		</div>

		{#if modelConfig.provider === 'custom-openai'}
			<div class="space-y-4 border-t border-border pt-4">
				<div>
					<Label for="custom-endpoint" class="mb-1 block">Endpoint URL *</Label>
					<Input
						id="custom-endpoint"
						value={customOpenAIEndpoint}
						oninput={(e) => (customOpenAIEndpoint = e.currentTarget.value)}
						placeholder="http://localhost:8000/v1"
					/>
					<p class="mt-1 text-xs text-muted-foreground">Base URL of the OpenAI-compatible API</p>
				</div>

				<div>
					<Label for="custom-model" class="mb-1 block">Model Name *</Label>
					<Input
						id="custom-model"
						value={customOpenAIModel}
						oninput={(e) => (customOpenAIModel = e.currentTarget.value)}
						placeholder="gpt-4, llama-3-70b, etc."
					/>
					<p class="mt-1 text-xs text-muted-foreground">Model identifier to use for requests</p>
				</div>

				<div>
					<Label for="custom-api-key" class="mb-1 block">API Key (optional)</Label>
					<Input
						id="custom-api-key"
						type="password"
						value={customOpenAIApiKey}
						oninput={(e) => (customOpenAIApiKey = e.currentTarget.value)}
						placeholder="Leave empty if not required"
					/>
				</div>

				<div>
					<button
						type="button"
						class="flex w-full items-center justify-between py-2"
						onclick={() => (isCustomOpenAIAdvancedOpen = !isCustomOpenAIAdvancedOpen)}
					>
						<Label class="cursor-pointer">Advanced Options</Label>
						{#if isCustomOpenAIAdvancedOpen}
							<ChevronUp class="size-4 text-muted-foreground" />
						{:else}
							<ChevronDown class="size-4 text-muted-foreground" />
						{/if}
					</button>

					{#if isCustomOpenAIAdvancedOpen}
						<div class="mt-2 space-y-3 border-l-2 border-border pl-2">
							<div>
								<Label for="custom-max-tokens" class="mb-1 block">Max Tokens</Label>
								<Input
									id="custom-max-tokens"
									type="number"
									value={customMaxTokens}
									oninput={(e) => (customMaxTokens = e.currentTarget.value)}
									placeholder="e.g., 4096"
								/>
							</div>
							<div>
								<Label for="custom-temperature" class="mb-1 block">Temperature (0.0-2.0)</Label>
								<Input
									id="custom-temperature"
									type="number"
									step="0.1"
									min="0"
									max="2"
									value={customTemperature}
									oninput={(e) => (customTemperature = e.currentTarget.value)}
									placeholder="e.g., 0.7"
								/>
							</div>
							<div>
								<Label for="custom-top-p" class="mb-1 block">Top P (0.0-1.0)</Label>
								<Input
									id="custom-top-p"
									type="number"
									step="0.1"
									min="0"
									max="1"
									value={customTopP}
									oninput={(e) => (customTopP = e.currentTarget.value)}
									placeholder="e.g., 0.9"
								/>
							</div>
						</div>
					{/if}
				</div>

				<Button
					variant="outline"
					size="sm"
					class="w-full"
					disabled={isTestingConnection || !customOpenAIEndpoint.trim() || !customOpenAIModel.trim()}
					onclick={testCustomOpenAIConnection}
				>
					{#if isTestingConnection}
						<RefreshCw class="size-4 animate-spin" /> Testing Connection…
					{:else}
						<CheckCircle2 class="size-4" /> Test Connection
					{/if}
				</Button>
			</div>
		{/if}

		{#if cloudProvider}
			<div class="space-y-4 border-t border-border pt-4">
				<Alert variant="warning">
					Heads up: with {cloudProvider.name}, your meeting transcript and notes are sent to
					{cloudProvider.name}'s servers to generate the summary — this leaves your device. The
					Built-in AI and Ollama options keep everything offline.
				</Alert>

				<div>
					<Label for="cloud-api-key" class="mb-1 block">API Key *</Label>
					<Input
						id="cloud-api-key"
						type="password"
						value={modelConfig.apiKey ?? ''}
						oninput={(e) => setModelConfig({ ...modelConfig, apiKey: e.currentTarget.value })}
						placeholder="Paste your API key"
					/>
					<p class="mt-1 text-xs text-muted-foreground">
						Stored locally on this device. Get a key at
						<button
							type="button"
							class="text-accent underline"
							onclick={() => invoke('open_external_url', { url: cloudProvider.keyUrl })}
						>
							{cloudProvider.keyUrl.replace('https://', '')}
						</button>
					</p>
				</div>

				<div>
					<Label for="cloud-model" class="mb-1 block">Model *</Label>
					<Input
						id="cloud-model"
						value={modelConfig.model}
						oninput={(e) => setModelConfig({ ...modelConfig, model: e.currentTarget.value })}
						placeholder={cloudProvider.modelPlaceholder}
					/>
					<p class="mt-1 text-xs text-muted-foreground">
						The model identifier to request from {cloudProvider.name}.
					</p>
				</div>
			</div>
		{/if}

		{#if modelConfig.provider === 'ollama'}
			<div>
				<button
					type="button"
					class="flex w-full items-center justify-between py-2"
					onclick={() => (isEndpointSectionCollapsed = !isEndpointSectionCollapsed)}
				>
					<Label class="cursor-pointer">Custom Endpoint (optional)</Label>
					{#if isEndpointSectionCollapsed}
						<ChevronDown class="size-4 text-muted-foreground" />
					{:else}
						<ChevronUp class="size-4 text-muted-foreground" />
					{/if}
				</button>

				{#if !isEndpointSectionCollapsed}
					<p class="mb-2 mt-1 text-sm text-muted-foreground">
						Leave empty or enter a custom endpoint (e.g., http://x.yy.zz:11434)
					</p>
					<div class="mt-1 flex gap-2">
						<div class="relative flex-1">
							<Input
								type="url"
								value={ollamaEndpoint}
								oninput={(e) => handleEndpointInput(e.currentTarget.value)}
								placeholder="http://localhost:11434"
								class={cn('pr-10', endpointValidationState === 'invalid' && 'border-destructive')}
							/>
							{#if endpointValidationState === 'valid'}
								<CheckCircle2
									class="absolute right-3 top-1/2 size-5 -translate-y-1/2 text-green-600"
								/>
							{:else if endpointValidationState === 'invalid'}
								<XCircle class="absolute right-3 top-1/2 size-5 -translate-y-1/2 text-destructive" />
							{/if}
						</div>
						<Button
							variant="outline"
							size="sm"
							class="whitespace-nowrap"
							disabled={isLoadingOllama}
							onclick={() => fetchOllamaModels()}
						>
							{#if isLoadingOllama}
								<RefreshCw class="size-4 animate-spin" /> Fetching…
							{:else}
								<RefreshCw class="size-4" /> Fetch Models
							{/if}
						</Button>
					</div>
					{#if ollamaEndpointChanged && !error}
						<Alert variant="warning" class="mt-3">
							Endpoint changed. Please click "Fetch Models" to load models from the new endpoint
							before saving.
						</Alert>
					{/if}
				{/if}
			</div>

			<div>
				<div class="mb-4 flex items-center justify-between">
					<h4 class="text-sm font-bold">Available Ollama Models</h4>
					{#if lastFetchedEndpoint && models.length > 0}
						<div class="flex items-center gap-2 text-sm">
							<span class="text-muted-foreground">Using:</span>
							<code class="rounded bg-secondary px-2 py-1 text-xs">
								{lastFetchedEndpoint || 'http://localhost:11434'}
							</code>
						</div>
					{/if}
				</div>

				{#if models.length > 0}
					<div class="mb-4">
						<Input
							placeholder="Search models…"
							value={searchQuery}
							oninput={(e) => (searchQuery = e.currentTarget.value)}
						/>
					</div>
				{/if}

				{#if isLoadingOllama}
					<div class="py-8 text-center text-muted-foreground">
						<RefreshCw class="mx-auto mb-2 size-8 animate-spin" />
						Loading models...
					</div>
				{:else if models.length === 0}
					<div class="space-y-3">
						{#if ollamaNotInstalled}
							<div class="space-y-4">
								<Alert variant="warning">
									Ollama is not installed or not running. Please download and install Ollama to use
									local models.
								</Alert>
								<Button
									variant="accent"
									size="sm"
									class="w-full"
									onclick={() =>
										invoke('open_external_url', { url: 'https://ollama.com/download' })}
								>
									<ExternalLink class="size-4" /> Download Ollama
								</Button>
								<div class="text-center text-sm text-muted-foreground">
									After installing Ollama, restart this application and click "Fetch Models" to
									continue.
								</div>
							</div>
						{:else}
							<Alert class="mb-4">
								{ollamaEndpointChanged
									? 'Endpoint changed. Click "Fetch Models" to load models from the new endpoint.'
									: 'No models found. Download a recommended model or click "Fetch Models" to load available Ollama models.'}
							</Alert>
							{#if !ollamaEndpointChanged}
								{@const downloading = ollamaDownload.isDownloading(RECOMMENDED_MODEL)}
								{@const progress = ollamaDownload.getProgress(RECOMMENDED_MODEL)}
								<div class="space-y-3">
									<Button
										variant="outline"
										size="sm"
										class="w-full"
										disabled={downloading}
										onclick={downloadRecommendedModel}
									>
										{#if downloading}
											<RefreshCw class="size-4 animate-spin" /> Downloading {RECOMMENDED_MODEL}…
										{:else}
											<Download class="size-4" /> Download {RECOMMENDED_MODEL} (Recommended, ~800MB)
										{/if}
									</Button>

									{#if downloading && progress !== undefined}
										<div class="rounded-md border border-border p-3">
											<div class="mb-2 flex items-center justify-between">
												<span class="text-sm font-medium">Downloading {RECOMMENDED_MODEL}</span>
												<span class="text-sm font-semibold">{Math.round(progress)}%</span>
											</div>
											<div class="h-2 w-full overflow-hidden rounded-full bg-secondary">
												<div
													class="h-full rounded-full bg-primary transition-all duration-300"
													style={`width: ${progress}%`}
												></div>
											</div>
										</div>
									{/if}
								</div>
							{/if}
						{/if}
					</div>
				{:else if !ollamaEndpointChanged}
					<ScrollArea class="max-h-[calc(100vh-450px)] pr-4">
						{#if filteredModels.length === 0}
							<Alert>No models found matching "{searchQuery}". Try a different search term.</Alert>
						{:else}
							<div class="grid gap-4">
								{#each filteredModels as model (model.id)}
									{@const modelIsDownloading = ollamaDownload.isDownloading(model.name)}
									{@const progress = ollamaDownload.getProgress(model.name)}
									<div
										role="button"
										tabindex="0"
										onclick={() =>
											!modelIsDownloading && setModelConfig({ ...modelConfig, model: model.name })}
										onkeydown={(e) =>
											e.key === 'Enter' &&
											!modelIsDownloading &&
											setModelConfig({ ...modelConfig, model: model.name })}
										class={cn(
											'rounded-md border bg-card p-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
											modelConfig.model === model.name
												? 'border-accent ring-1 ring-inset ring-accent'
												: 'border-border hover:bg-secondary/50',
											!modelIsDownloading && 'cursor-pointer'
										)}
									>
										<div>
											<b class="font-bold">{model.name}&nbsp;</b>
											<span class="text-muted-foreground">with a size of </span>
											<span class="font-mono text-sm font-bold">{model.size}</span>
										</div>

										{#if modelIsDownloading && progress !== undefined}
											<div class="mt-3 border-t border-border pt-3">
												<div class="mb-2 flex items-center justify-between">
													<span class="text-sm font-medium">Downloading...</span>
													<span class="text-sm font-semibold">{Math.round(progress)}%</span>
												</div>
												<div class="h-2 w-full overflow-hidden rounded-full bg-secondary">
													<div
														class="h-full rounded-full bg-primary transition-all duration-300"
														style={`width: ${progress}%`}
													></div>
												</div>
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</ScrollArea>
				{/if}
			</div>
		{/if}

		{#if modelConfig.provider === 'builtin-ai'}
			<div class="mt-6">
				<BuiltInModelManager
					selectedModel={modelConfig.model}
					onModelSelect={(model) => setModelConfig({ ...modelConfig, model })}
				/>
			</div>
		{/if}
	</div>

	<div class="mt-6 flex justify-end">
		<Button variant="accent" disabled={isDoneDisabled} onclick={handleSave}>Save</Button>
	</div>
</div>
