/**
 * App configuration store.
 *
 * Holds: model config, transcript model config, device selection, language,
 * UI preferences, beta features, Ollama model list, provider API keys, and
 * the lazy-loaded notification / storage location settings.
 *
 * localStorage-backed where appropriate. Persists to Rust via the config
 * service for transcript / model / device prefs.
 *
 * Mirrors the React ConfigContext.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { Analytics } from '$lib/analytics';
import {
	configService,
	type ModelConfig,
	type TranscriptModelProps,
	type VocabularyEntry,
} from '$lib/services/config';
import {
	DEFAULT_BETA_FEATURES,
	loadBetaFeatures,
	saveBetaFeatures,
	type BetaFeatures,
	type BetaFeatureKey,
} from '$lib/beta-features';

export interface OllamaModel {
	name: string;
	id: string;
	size: string;
	modified: string;
}

export interface SelectedDevices {
	micDevice: string | null;
	systemDevice: string | null;
}

export interface StorageLocations {
	database: string;
	models: string;
	recordings: string;
}

export interface NotificationSettings {
	recording_notifications: boolean;
	time_based_reminders: boolean;
	meeting_reminders: boolean;
	respect_do_not_disturb: boolean;
	notification_sound: boolean;
	system_permission_granted: boolean;
	consent_given: boolean;
	manual_dnd_mode: boolean;
	notification_preferences: {
		show_recording_started: boolean;
		show_recording_stopped: boolean;
		show_recording_paused: boolean;
		show_recording_resumed: boolean;
		show_transcription_complete: boolean;
		show_meeting_reminders: boolean;
		show_system_errors: boolean;
		meeting_reminder_minutes: number[];
	};
}

interface VocabularyLearningUpdate {
	preferred: string;
	alias: { from: string; observations: number };
}

export type ProviderApiKeys = {
	claude: string | null;
	groq: string | null;
	grok: string | null;
	openai: string | null;
	openrouter: string | null;
};

const isBrowser = typeof window !== 'undefined';

function readLocalString(key: string, fallback: string): string {
	if (!isBrowser) return fallback;
	return localStorage.getItem(key) ?? fallback;
}

function readLocalBoolean(key: string, fallback: boolean): boolean {
	if (!isBrowser) return fallback;
	const saved = localStorage.getItem(key);
	return saved === null ? fallback : saved === 'true';
}

function writeLocalString(key: string, value: string): void {
	if (!isBrowser) return;
	localStorage.setItem(key, value);
}

function writeLocalBoolean(key: string, value: boolean): void {
	writeLocalString(key, value.toString());
}

class ConfigStore {
	modelConfig = $state<ModelConfig>({
		provider: 'ollama',
		model: 'llama3.2:latest',
		whisperModel: 'large-v3',
		ollamaEndpoint: null,
	});

	transcriptModelConfig = $state<TranscriptModelProps>({
		provider: 'automatic',
		model: 'automatic',
		apiKey: null,
	});

	providerApiKeys = $state<ProviderApiKeys>({
		claude: null,
		groq: null,
		grok: null,
		openai: null,
		openrouter: null,
	});

	models = $state<OllamaModel[]>([]);
	error = $state<string>('');

	selectedDevices = $state<SelectedDevices>({ micDevice: null, systemDevice: null });

	selectedLanguage = $state<string>(readLocalString('primaryLanguage', 'auto'));
	customVocabulary = $state<VocabularyEntry[]>([]);
	showConfidenceIndicator = $state<boolean>(readLocalBoolean('showConfidenceIndicator', true));
	isAutoSummary = $state<boolean>(readLocalBoolean('isAutoSummary', false));
	globalShortcutEnabled = $state<boolean>(readLocalBoolean('globalShortcutEnabled', true));

	betaFeatures = $state<BetaFeatures>(
		isBrowser ? loadBetaFeatures() : { ...DEFAULT_BETA_FEATURES },
	);

	notificationSettings = $state<NotificationSettings | null>(null);
	storageLocations = $state<StorageLocations | null>(null);
	isLoadingPreferences = $state(false);

	get modelOptions(): Record<ModelConfig['provider'], string[]> {
		return {
			ollama: this.models.map((m) => m.name),
			claude: ['claude-3-5-sonnet-latest'],
			groq: ['llama-3.3-70b-versatile'],
			grok: ['grok-3', 'grok-3-mini', 'grok-3-fast', 'grok-3-mini-fast'],
			openrouter: [],
			openai: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
			'builtin-ai': [],
			'custom-openai': [],
		};
	}

	#preferencesLoaded = false;
	#preferencesLoading = false;
	#unsubscribers: UnlistenFn[] = [];
	#started = false;
	#vocabularySaveTimer: ReturnType<typeof setTimeout> | undefined;
	#vocabularySaveGeneration = 0;
	#pendingVocabularyEntries: VocabularyEntry[] | undefined;

	async start(): Promise<() => void> {
		if (this.#started) {
			return () => this.#cleanup();
		}
		this.#started = true;

		// Fire-and-forget initial loads — they each handle their own errors.
		void this.#loadOllamaModels();
		void this.#loadTranscriptConfig();
		void this.#initLanguagePreference();
		invoke('set_recording_shortcut_enabled', { enabled: this.globalShortcutEnabled }).catch((err) =>
			console.error('Failed to apply recording shortcut state:', err),
		);
		void this.#loadModelConfig();
		void this.#loadProviderApiKeys();
		void this.#loadDevicePreferences();

		try {
			const unlistenModelConfig = await listen<ModelConfig>('model-config-updated', (event) => {
				this.modelConfig = event.payload;
				if (event.payload.apiKey && event.payload.provider !== 'custom-openai') {
					this.updateProviderApiKey(event.payload.provider, event.payload.apiKey);
				}
			});
			this.#unsubscribers.push(unlistenModelConfig);
		} catch (error) {
			console.error('[ConfigStore] Failed to set up model-config-updated listener:', error);
		}

		try {
			const unlistenVocabulary = await listen<VocabularyLearningUpdate>(
				'vocabulary-learning-updated',
				(event) => {
					this.customVocabulary = this.customVocabulary.map((entry) => {
						if (entry.to.toLocaleLowerCase() !== event.payload.preferred.toLocaleLowerCase()) {
							return entry;
						}
						const learned = entry.learned_aliases ?? [];
						const existing = learned.findIndex(
							(alias) =>
								alias.from.toLocaleLowerCase() === event.payload.alias.from.toLocaleLowerCase(),
						);
						return {
							...entry,
							learned_aliases:
								existing === -1
									? [...learned, event.payload.alias]
									: learned.map((alias, index) =>
											index === existing ? event.payload.alias : alias,
										),
						};
					});
				},
			);
			this.#unsubscribers.push(unlistenVocabulary);
			void this.#loadCustomVocabulary();
		} catch (error) {
			console.error('[ConfigStore] Failed to set up vocabulary learning listener:', error);
			void this.#loadCustomVocabulary();
		}

		return () => this.#cleanup();
	}

	#cleanup(): void {
		this.flushCustomVocabulary();
		for (const fn of this.#unsubscribers) {
			fn();
		}
		this.#unsubscribers = [];
		this.#started = false;
	}

	async #loadOllamaModels(): Promise<void> {
		try {
			const endpoint = this.modelConfig.ollamaEndpoint || null;
			const list = await invoke<OllamaModel[]>('get_ollama_models', { endpoint });
			this.models = list;
			this.error = '';
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Failed to load Ollama models';
		}
	}

	async #loadTranscriptConfig(): Promise<void> {
		try {
			const config = await configService.getTranscriptConfig();
			if (config) {
				this.transcriptModelConfig = {
					provider: config.provider ?? 'automatic',
					model: config.model ?? 'automatic',
					apiKey: config.apiKey ?? null,
				};
			}
		} catch (error) {
			console.error('[ConfigStore] Failed to load transcript config:', error);
		}
	}

	async #initLanguagePreference(): Promise<void> {
		try {
			// The settings DB is the source of truth. If it holds a value, adopt it
			// and refresh the localStorage cache from it. If it has none, run a
			// one-time migration of the legacy localStorage value into the DB. The
			// "DB value is set" check is the idempotency guard, so this never
			// clobbers across launches.
			const dbLanguage = await invoke<string | null>('get_transcription_language');
			if (dbLanguage) {
				this.selectedLanguage = dbLanguage;
				writeLocalString('primaryLanguage', dbLanguage);
			} else if (this.selectedLanguage) {
				// `selectedLanguage` defaults to 'auto', so this also persists the
				// default on first run. That is intentional: 'auto' in the DB is
				// equivalent to unset (both fall back to auto-detect).
				await invoke('set_language_preference', { language: this.selectedLanguage });
			}
		} catch (error) {
			console.error('[ConfigStore] Failed to initialize language preference:', error);
		}
	}

	async #loadCustomVocabulary(): Promise<void> {
		const generation = this.#vocabularySaveGeneration;
		try {
			const entries = await invoke<VocabularyEntry[]>('get_custom_vocabulary');
			if (generation !== this.#vocabularySaveGeneration) return;
			this.customVocabulary = (entries ?? []).map((entry) => {
				const local = this.customVocabulary.find(
					(candidate) => candidate.to.toLocaleLowerCase() === entry.to.toLocaleLowerCase(),
				);
				if (!local?.learned_aliases?.length) return entry;
				const learned = [...(entry.learned_aliases ?? [])];
				for (const alias of local.learned_aliases) {
					const saved = learned.find(
						(candidate) => candidate.from.toLocaleLowerCase() === alias.from.toLocaleLowerCase(),
					);
					if (saved) saved.observations = Math.max(saved.observations, alias.observations);
					else learned.push(alias);
				}
				return { ...entry, learned_aliases: learned };
			});
		} catch (error) {
			console.error('[ConfigStore] Failed to load custom vocabulary:', error);
		}
	}

	async #loadModelConfig(): Promise<void> {
		try {
			const data = await configService.getModelConfig();
			if (!data || !data.provider) return;

			if (data.provider === 'custom-openai') {
				try {
					const customConfig = await configService.getCustomOpenAIConfig();
					if (customConfig) {
						const resolvedModel = customConfig.model || data.model || '';
						this.modelConfig = {
							...this.modelConfig,
							provider: data.provider,
							model: resolvedModel || this.modelConfig.model,
							whisperModel: data.whisperModel || this.modelConfig.whisperModel,
							customOpenAIEndpoint: customConfig.endpoint,
							customOpenAIModel: customConfig.model,
							customOpenAIApiKey: customConfig.apiKey,
							maxTokens: customConfig.maxTokens,
							temperature: customConfig.temperature,
							topP: customConfig.topP,
						};

						if (resolvedModel) {
							this.#seedProviderModelMap(data.provider, resolvedModel);
						}
						return;
					}
				} catch (err) {
					console.error('[ConfigStore] Failed to fetch custom OpenAI config:', err);
				}
			}

			this.modelConfig = {
				...this.modelConfig,
				provider: data.provider,
				model: data.model || this.modelConfig.model,
				whisperModel: data.whisperModel || this.modelConfig.whisperModel,
				ollamaEndpoint: data.ollamaEndpoint,
			};

			if (data.model) {
				this.#seedProviderModelMap(data.provider, data.model);
			}
		} catch (error) {
			console.error('[ConfigStore] Failed to fetch model config:', error);
		}
	}

	#seedProviderModelMap(provider: string, model: string): void {
		if (!isBrowser) return;
		try {
			const raw = localStorage.getItem('providerModelMap');
			const map: Record<string, string> = raw ? JSON.parse(raw) : {};
			map[provider] = model;
			localStorage.setItem('providerModelMap', JSON.stringify(map));
		} catch (error) {
			console.error('[ConfigStore] Failed to update providerModelMap:', error);
		}
	}

	async #loadProviderApiKeys(): Promise<void> {
		try {
			const [claude, groq, grok, openai, openrouter] = await Promise.all(
				(['claude', 'groq', 'grok', 'openai', 'openrouter'] as const).map((p) =>
					invoke<string>('api_get_api_key', { provider: p }).catch(() => null),
				),
			);
			this.providerApiKeys = {
				claude: claude ?? null,
				groq: groq ?? null,
				grok: grok ?? null,
				openai: openai ?? null,
				openrouter: openrouter ?? null,
			};
		} catch (error) {
			console.error('[ConfigStore] Failed to load provider API keys:', error);
		}
	}

	async #loadDevicePreferences(): Promise<void> {
		try {
			const prefs = await configService.getRecordingPreferences();
			if (prefs && (prefs.preferred_mic_device || prefs.preferred_system_device)) {
				this.selectedDevices = {
					micDevice: prefs.preferred_mic_device,
					systemDevice: prefs.preferred_system_device,
				};
			}
		} catch (error) {
			console.log('[ConfigStore] No device preferences found or failed to load:', error);
		}
	}

	setSelectedLanguage = (lang: string): void => {
		this.selectedLanguage = lang;
		writeLocalString('primaryLanguage', lang);
		invoke('set_language_preference', { language: lang }).catch((err) =>
			console.error('Failed to sync language preference to Rust:', err),
		);
	};

	setCustomVocabulary = (entries: VocabularyEntry[]): void => {
		this.customVocabulary = entries;
		this.#vocabularySaveGeneration += 1;
		this.#pendingVocabularyEntries = entries;
		if (this.#vocabularySaveTimer) clearTimeout(this.#vocabularySaveTimer);
		this.#vocabularySaveTimer = setTimeout(() => {
			this.flushCustomVocabulary();
		}, 300);
	};

	flushCustomVocabulary = (): void => {
		if (this.#vocabularySaveTimer) clearTimeout(this.#vocabularySaveTimer);
		this.#vocabularySaveTimer = undefined;
		const entries = this.#pendingVocabularyEntries;
		this.#pendingVocabularyEntries = undefined;
		if (!entries) return;
		void invoke<VocabularyEntry[]>('set_custom_vocabulary', { entries }).catch((err) =>
			console.error('Failed to sync custom vocabulary to Rust:', err),
		);
	};

	removeLearnedVocabularyAlias = async (preferred: string, alias: string): Promise<void> => {
		const generation = this.#vocabularySaveGeneration;
		this.customVocabulary = this.customVocabulary.map((entry) =>
			entry.to.toLocaleLowerCase() === preferred.toLocaleLowerCase()
				? {
						...entry,
						learned_aliases: (entry.learned_aliases ?? []).filter(
							(learned) => learned.from.toLocaleLowerCase() !== alias.toLocaleLowerCase(),
						),
					}
				: entry,
		);
		try {
			await invoke<VocabularyEntry[]>('remove_learned_vocabulary_alias', {
				preferred,
				alias,
			});
		} catch (error) {
			console.error('Failed to remove learned vocabulary correction:', error);
			if (generation === this.#vocabularySaveGeneration) void this.#loadCustomVocabulary();
		}
	};

	toggleConfidenceIndicator = (checked: boolean): void => {
		this.showConfidenceIndicator = checked;
		writeLocalBoolean('showConfidenceIndicator', checked);
		if (isBrowser) {
			window.dispatchEvent(new CustomEvent('confidenceIndicatorChanged', { detail: checked }));
		}
	};

	toggleIsAutoSummary = (checked: boolean): void => {
		this.isAutoSummary = checked;
		writeLocalBoolean('isAutoSummary', checked);
	};

	toggleGlobalShortcut = (enabled: boolean): void => {
		this.globalShortcutEnabled = enabled;
		writeLocalBoolean('globalShortcutEnabled', enabled);
		invoke('set_recording_shortcut_enabled', { enabled }).catch((err) =>
			console.error('Failed to sync recording shortcut state:', err),
		);
	};

	setTranscriptModelConfig = (config: TranscriptModelProps): void => {
		this.transcriptModelConfig = config;
	};

	setSelectedDevices = (devices: SelectedDevices): void => {
		this.selectedDevices = devices;
	};

	toggleBetaFeature = (featureKey: BetaFeatureKey, enabled: boolean): void => {
		const updated = { ...this.betaFeatures, [featureKey]: enabled };
		this.betaFeatures = updated;
		saveBetaFeatures(updated);

		Analytics.track('beta_feature_toggled', {
			feature: featureKey,
			enabled: enabled.toString(),
		}).catch((err) => console.error('Failed to track beta feature toggle:', err));
	};

	updateProviderApiKey = (provider: string, apiKey: string | null): void => {
		this.providerApiKeys = { ...this.providerApiKeys, [provider]: apiKey };
	};

	loadPreferences = async (): Promise<void> => {
		if (this.#preferencesLoaded || this.#preferencesLoading) return;

		this.#preferencesLoading = true;
		this.isLoadingPreferences = true;

		try {
			try {
				const settings = await invoke<NotificationSettings>('get_notification_settings');
				this.notificationSettings = settings;
			} catch (notifError) {
				console.error('[ConfigStore] Failed to load notification settings:', notifError);
				this.notificationSettings = null;
			}

			const [dbDir, modelsDir, recordingsDir] = await Promise.all([
				invoke<string>('get_database_directory'),
				invoke<string>('whisper_get_models_directory'),
				invoke<string>('get_default_recordings_folder_path'),
			]);

			this.storageLocations = {
				database: dbDir,
				models: modelsDir,
				recordings: recordingsDir,
			};

			this.#preferencesLoaded = true;
		} catch (error) {
			console.error('[ConfigStore] Failed to load preferences:', error);
		} finally {
			this.#preferencesLoading = false;
			this.isLoadingPreferences = false;
		}
	};

	updateNotificationSettings = async (settings: NotificationSettings): Promise<void> => {
		await invoke('set_notification_settings', { settings });
		this.notificationSettings = settings;
	};
}

export const config = new ConfigStore();
