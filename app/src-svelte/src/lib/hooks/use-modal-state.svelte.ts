/**
 * useModalState
 *
 * Consolidated modal visibility + message state, plus Tauri listeners for
 * chunk-drop warnings, transcription errors, and model-download auto-close.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onMount } from 'svelte';

import type { TranscriptModelProps } from '$lib/services/config';
import { toast } from '$lib/toast';

export type ModalType =
	| 'modelSettings'
	| 'deviceSettings'
	| 'languageSettings'
	| 'modelSelector'
	| 'errorAlert'
	| 'chunkDropWarning';

interface ModalState {
	modelSettings: boolean;
	deviceSettings: boolean;
	languageSettings: boolean;
	modelSelector: boolean;
	errorAlert: boolean;
	chunkDropWarning: boolean;
}

interface ModalMessages {
	errorAlert: string;
	chunkDropWarning: string;
	modelSelector: string;
}

const MESSAGE_MODAL_KEYS = new Set<ModalType>(['errorAlert', 'chunkDropWarning', 'modelSelector']);

const initialModals = (): ModalState => ({
	modelSettings: false,
	deviceSettings: false,
	languageSettings: false,
	modelSelector: false,
	errorAlert: false,
	chunkDropWarning: false,
});

const initialMessages = (): ModalMessages => ({
	errorAlert: '',
	chunkDropWarning: '',
	modelSelector: '',
});

export interface UseModalState {
	readonly modals: ModalState;
	readonly messages: ModalMessages;
	showModal: (name: ModalType, message?: string) => void;
	hideModal: (name: ModalType) => void;
	hideAllModals: () => void;
}

export function useModalState(transcriptModelConfig?: TranscriptModelProps): UseModalState {
	let modals = $state<ModalState>(initialModals());
	let messages = $state<ModalMessages>(initialMessages());

	const showModal = (name: ModalType, message?: string): void => {
		modals = { ...modals, [name]: true };
		if (message && MESSAGE_MODAL_KEYS.has(name)) {
			messages = { ...messages, [name]: message };
		}
	};

	const hideModal = (name: ModalType): void => {
		modals = { ...modals, [name]: false };
		if (MESSAGE_MODAL_KEYS.has(name)) {
			messages = { ...messages, [name]: '' };
		}
	};

	const hideAllModals = (): void => {
		modals = initialModals();
		messages = initialMessages();
	};

	onMount(() => {
		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;

		(async () => {
			try {
				const unlistenChunk = await listen<string>('chunk-drop-warning', (event) => {
					showModal('chunkDropWarning', event.payload);
				});
				if (cancelled) unlistenChunk();
				else unsubscribers.push(unlistenChunk);

				const unlistenError = await listen<{
					error: string;
					userMessage: string;
					actionable: boolean;
				}>('transcription-error', (event) => {
					const { userMessage, actionable } = event.payload;
					if (actionable) {
						showModal('modelSelector', userMessage);
					} else {
						toast.error('', { description: userMessage, duration: 5000 });
					}
				});
				if (cancelled) unlistenError();
				else unsubscribers.push(unlistenError);

				const unlistenWhisper = await listen<{ modelName: string }>(
					'model-download-complete',
					(event) => {
						const { modelName } = event.payload;
						if (
							transcriptModelConfig?.provider === 'localWhisper' &&
							transcriptModelConfig?.model === modelName
						) {
							toast.success('Model ready! Closing window...', { duration: 1500 });
							setTimeout(() => hideModal('modelSelector'), 1500);
						}
					},
				);
				if (cancelled) unlistenWhisper();
				else unsubscribers.push(unlistenWhisper);
			} catch (error) {
				console.error('[useModalState] Failed to set up listeners:', error);
			}
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});

	return {
		get modals() {
			return modals;
		},
		get messages() {
			return messages;
		},
		showModal,
		hideModal,
		hideAllModals,
	};
}
