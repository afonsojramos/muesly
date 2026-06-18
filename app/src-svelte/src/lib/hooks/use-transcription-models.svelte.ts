/**
 * useTranscriptionModels
 *
 * Fetches Whisper + Parakeet models and tracks which one the user selected.
 * Defaults to the configured-and-available model on first load, but never
 * overrides a manual selection.
 */

import { invoke } from '@tauri-apps/api/core';

export interface RawModelInfo {
	name: string;
	size_mb: number;
	status:
		| 'Available'
		| 'Missing'
		| { Downloading: { progress: number } }
		| { Error: string };
}

export interface ModelOption {
	provider: 'whisper' | 'parakeet';
	name: string;
	displayName: string;
	size_mb: number;
}

interface TranscriptModelConfig {
	provider?: string;
	model?: string;
}

export interface UseTranscriptionModels {
	readonly availableModels: ModelOption[];
	readonly selectedModelKey: string;
	readonly loadingModels: boolean;
	setSelectedModelKey: (key: string) => void;
	fetchModels: () => Promise<void>;
	resetSelection: () => void;
}

export function useTranscriptionModels(
	getConfig: () => TranscriptModelConfig | undefined
): UseTranscriptionModels {
	let availableModels = $state<ModelOption[]>([]);
	let selectedModelKey = $state<string>('');
	let loadingModels = $state(false);
	let userSelected = false;

	const setSelectedModelKey = (key: string): void => {
		userSelected = true;
		selectedModelKey = key;
	};

	const resetSelection = (): void => {
		userSelected = false;
	};

	const fetchModels = async (): Promise<void> => {
		loadingModels = true;
		const all: ModelOption[] = [];

		try {
			const whisper = await invoke<RawModelInfo[]>('whisper_get_available_models');
			for (const m of whisper) {
				if (m.status === 'Available') {
					all.push({
						provider: 'whisper',
						name: m.name,
						displayName: `🏠 Whisper: ${m.name}`,
						size_mb: m.size_mb
					});
				}
			}
		} catch (err) {
			console.error('Failed to fetch Whisper models:', err);
		}

		try {
			const parakeet = await invoke<RawModelInfo[]>('parakeet_get_available_models');
			for (const m of parakeet) {
				if (m.status === 'Available') {
					all.push({
						provider: 'parakeet',
						name: m.name,
						displayName: `⚡ Parakeet: ${m.name}`,
						size_mb: m.size_mb
					});
				}
			}
		} catch (err) {
			console.error('Failed to fetch Parakeet models:', err);
		}

		availableModels = all;

		const config = getConfig();
		const configuredProvider = config?.provider ?? '';
		const configuredModel = config?.model ?? '';

		const configuredMatch = all.find(
			(m) =>
				(configuredProvider === 'localWhisper' &&
					m.provider === 'whisper' &&
					m.name === configuredModel) ||
				(configuredProvider === 'parakeet' &&
					m.provider === 'parakeet' &&
					m.name === configuredModel)
		);

		if (!userSelected) {
			if (configuredMatch) {
				selectedModelKey = `${configuredMatch.provider}:${configuredMatch.name}`;
			} else {
				const first = all[0];
				if (first) {
					selectedModelKey = `${first.provider}:${first.name}`;
				}
			}
		}

		loadingModels = false;
	};

	return {
		get availableModels() {
			return availableModels;
		},
		get selectedModelKey() {
			return selectedModelKey;
		},
		get loadingModels() {
			return loadingModels;
		},
		setSelectedModelKey,
		fetchModels,
		resetSelection
	};
}
