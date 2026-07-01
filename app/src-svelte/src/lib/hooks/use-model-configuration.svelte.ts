/**
 * useModelConfiguration
 *
 * Loads + persists the summary model configuration for a given meeting view.
 * Auto-fetches missing API keys and the custom-openai sub-config.
 *
 * Components on the meeting-details page should use this instead of the global
 * `config` store when they need a config snapshot scoped to a single edit.
 */

import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onMount } from 'svelte';

import { Analytics } from '$lib/analytics';
import type { ModelConfig } from '$lib/services/config';
import { toast } from '$lib/toast';

interface CustomOpenAIBlob {
	displayName?: string | null;
	endpoint?: string | null;
	model?: string | null;
	apiKey?: string | null;
	maxTokens?: number | null;
	temperature?: number | null;
	topP?: number | null;
}

const DEFAULT_CONFIG: ModelConfig = {
	provider: 'ollama',
	model: '',
	whisperModel: 'large-v3',
};

export interface UseModelConfiguration {
	readonly modelConfig: ModelConfig;
	readonly isLoading: boolean;
	setModelConfig: (config: ModelConfig) => void;
	handleSaveModelConfig: (updatedConfig?: ModelConfig) => Promise<void>;
}

export function useModelConfiguration(): UseModelConfiguration {
	let modelConfig = $state<ModelConfig>({ ...DEFAULT_CONFIG });
	let isLoading = $state(true);

	const fetchModelConfig = async (): Promise<void> => {
		isLoading = true;
		try {
			const data = (await invoke('api_get_model_config')) as ModelConfig | null;
			if (!data || data.provider === null) {
				return;
			}

			if (data.provider !== 'ollama' && data.provider !== 'custom-openai' && !data.apiKey) {
				try {
					data.apiKey = (await invoke('api_get_api_key', { provider: data.provider })) as string;
				} catch (err) {
					console.error('Failed to fetch API key:', err);
				}
			}

			if (data.provider === 'custom-openai') {
				try {
					const customConfig = (await invoke(
						'api_get_custom_openai_config',
					)) as CustomOpenAIBlob | null;
					if (customConfig) {
						data.customOpenAIEndpoint = customConfig.endpoint ?? null;
						data.customOpenAIModel = customConfig.model ?? null;
						data.customOpenAIApiKey = customConfig.apiKey ?? null;
						data.maxTokens = customConfig.maxTokens ?? null;
						data.temperature = customConfig.temperature ?? null;
						data.topP = customConfig.topP ?? null;
						data.model = customConfig.model ?? data.model;
					}
				} catch (err) {
					console.error('Failed to fetch custom OpenAI config:', err);
				}
			}

			modelConfig = data;
		} catch (error) {
			console.error('Failed to fetch model config:', error);
		} finally {
			isLoading = false;
		}
	};

	onMount(() => {
		void fetchModelConfig();

		let unlisten: UnlistenFn | undefined;
		let cancelled = false;
		listen<ModelConfig>('model-config-updated', (event) => {
			modelConfig = event.payload;
		}).then((fn) => {
			if (cancelled) fn();
			else unlisten = fn;
		});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	const handleSaveModelConfig = async (updatedConfig?: ModelConfig): Promise<void> => {
		try {
			const configToSave = updatedConfig ?? modelConfig;
			const payload: ModelConfig = {
				provider: configToSave.provider,
				model: configToSave.model,
				whisperModel: configToSave.whisperModel,
				apiKey: configToSave.apiKey ?? null,
				ollamaEndpoint: configToSave.ollamaEndpoint ?? null,
			};

			if (
				updatedConfig &&
				(updatedConfig.provider !== modelConfig.provider ||
					updatedConfig.model !== modelConfig.model)
			) {
				await Analytics.track('model_changed', {
					from_provider: modelConfig.provider,
					from_model: modelConfig.model,
					to_provider: updatedConfig.provider,
					to_model: updatedConfig.model,
				});
			}

			await invoke('api_save_model_config', { ...payload });
			modelConfig = payload;
			await emit('model-config-updated', payload);

			toast.success('Summary settings saved successfully');
			await Analytics.track('settings_changed', {
				setting: 'model_config',
				value: `${payload.provider}_${payload.model}`,
			});
		} catch (error) {
			console.error('Failed to save model config:', error);
			toast.error('Failed to save summary settings', { description: String(error) });
		}
	};

	return {
		get modelConfig() {
			return modelConfig;
		},
		get isLoading() {
			return isLoading;
		},
		setModelConfig: (config: ModelConfig) => {
			modelConfig = config;
		},
		handleSaveModelConfig,
	};
}
