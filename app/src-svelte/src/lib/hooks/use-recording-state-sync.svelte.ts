/**
 * useRecordingStateSync
 *
 * Recording/UI state sync lives in the `recordingState` store, which already
 * subscribes to Tauri events and polls while recording is active. So this
 * composable's only job is the local "isRecordingDisabled" flag that
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
		},
	};
}
