/**
 * Onboarding-specific types.
 *
 * No component prop interfaces live here: Svelte components express their own
 * props via `$props()` in the .svelte file itself. Only data shapes live here.
 */

export type OnboardingStep = 1 | 2 | 3 | 4;

export type PermissionStatus = 'checking' | 'not_determined' | 'authorized' | 'denied';

export interface OnboardingPermissions {
	microphone: PermissionStatus;
	systemAudio: PermissionStatus;
	screenRecording: PermissionStatus;
}
