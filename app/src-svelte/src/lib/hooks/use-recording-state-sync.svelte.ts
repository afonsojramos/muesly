/**
 * useRecordingStateSync
 *
 * In the React version this hook polled the backend and forced UI state in
 * sync. The Svelte port relies on the `recordingState` store, which already
 * subscribes to Tauri events and polls while recording is active. So this
 * composable's only remaining job is the local "isRecordingDisabled" flag that
 * components use to gate their own UI during transitions.
 */

export interface UseRecordingStateSync {
	readonly isRecordingDisabled: boolean;
	setIsRecordingDisabled: (value: boolean) => void;
}

export function useRecordingStateSync(): UseRecordingStateSync {
	let isRecordingDisabled = $state(false);

	return {
		get isRecordingDisabled() {
			return isRecordingDisabled;
		},
		setIsRecordingDisabled: (value: boolean) => {
			isRecordingDisabled = value;
		}
	};
}
