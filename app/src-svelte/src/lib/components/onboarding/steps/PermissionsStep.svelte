<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Mic, Volume2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import OnboardingContainer from '../OnboardingContainer.svelte';
	import PermissionRow from '../shared/PermissionRow.svelte';

	let isPending = $state(false);

	const isBrowser = typeof window !== 'undefined';

	// Re-check when the user returns from System Settings (window refocus), so a
	// grant made there flips the row without restarting onboarding. Reads no
	// reactive state synchronously, so this effect never re-runs.
	$effect(() => {
		const recheck = async (): Promise<void> => {
			try {
				const status = await invoke<string>('check_system_audio_permission_command');
				if (status === 'granted') {
					onboarding.setPermissionStatus('systemAudio', 'authorized');
				} else if (status === 'denied') {
					onboarding.setPermissionStatus('systemAudio', 'denied');
				}
			} catch {
				// Preflight unavailable; keep the current state.
			}
		};
		window.addEventListener('focus', recheck);
		return () => window.removeEventListener('focus', recheck);
	});

	async function handleMicrophoneAction(): Promise<void> {
		if (onboarding.permissions.microphone === 'denied') {
			try {
				await invoke('open_system_settings', { preferencePane: 'Privacy_Microphone' });
			} catch {
				alert(
					'Please enable microphone access in System Preferences > Security & Privacy > Microphone',
				);
			}
			return;
		}

		isPending = true;
		try {
			const granted = await invoke<boolean>('trigger_microphone_permission');
			onboarding.setPermissionStatus('microphone', granted ? 'authorized' : 'denied');
		} catch (err) {
			console.error('[PermissionsStep] Failed to request microphone permission:', err);
			onboarding.setPermissionStatus('microphone', 'denied');
		} finally {
			isPending = false;
		}
	}

	async function handleSystemAudioAction(): Promise<void> {
		if (onboarding.permissions.systemAudio === 'denied') {
			try {
				await invoke('open_system_settings', { preferencePane: 'Privacy_ScreenCapture' });
			} catch {
				alert(
					'Please enable muesly under System Settings → Privacy & Security → Screen & System Audio Recording',
				);
			}
			return;
		}

		isPending = true;
		try {
			// Backend preflights the TCC permission, fires the system consent
			// prompt if undetermined, and polls while the user answers it.
			const granted = await invoke<boolean>('trigger_system_audio_permission_command');
			onboarding.setPermissionStatus('systemAudio', granted ? 'authorized' : 'denied');
		} catch (err) {
			console.error('[PermissionsStep] Failed to request system audio permission:', err);
			onboarding.setPermissionStatus('systemAudio', 'denied');
		} finally {
			isPending = false;
		}
	}

	async function handleFinish(): Promise<void> {
		try {
			await onboarding.completeOnboarding();
			if (isBrowser) window.location.reload();
		} catch (error) {
			console.error('Failed to complete onboarding:', error);
		}
	}

	async function handleSkip(): Promise<void> {
		onboarding.setPermissionsSkipped(true);
		await handleFinish();
	}

	const allPermissionsGranted = $derived(
		onboarding.permissions.microphone === 'authorized' &&
			onboarding.permissions.systemAudio === 'authorized',
	);
</script>

<OnboardingContainer
	title="Grant Permissions"
	description="muesly needs access to your microphone and system audio to record meetings"
	step={4}
	hideProgress={true}
	showNavigation={allPermissionsGranted}
	canGoNext={allPermissionsGranted}
>
	<div class="mx-auto flex max-w-lg flex-col gap-6">
		<!-- Permission Rows -->
		<div class="flex flex-col gap-4">
			<PermissionRow
				title="Microphone"
				description="Required to capture your voice during meetings"
				status={onboarding.permissions.microphone}
				{isPending}
				onAction={handleMicrophoneAction}
			>
				{#snippet icon()}
					<Mic class="w-5 h-5" />
				{/snippet}
			</PermissionRow>

			<PermissionRow
				title="System Audio"
				description="Required to hear other meeting participants (System Audio Recording permission)"
				status={onboarding.permissions.systemAudio}
				{isPending}
				onAction={handleSystemAudioAction}
			>
				{#snippet icon()}
					<Volume2 class="w-5 h-5" />
				{/snippet}
			</PermissionRow>
		</div>

		<!-- Action Buttons -->
		<div class="flex flex-col gap-3 pt-4">
			<Button onclick={handleFinish} disabled={!allPermissionsGranted} class="h-11 w-full">
				Finish Setup
			</Button>

			<Button
				variant="ghost"
				size="sm"
				onclick={handleSkip}
				class="text-muted-foreground hover:text-foreground"
			>
				I'll do this later
			</Button>

			{#if !allPermissionsGranted}
				<p class="text-xs text-center text-muted-foreground">
					Recording won't work without permissions. You can grant them later in settings.
				</p>
			{/if}
		</div>
	</div>
</OnboardingContainer>
