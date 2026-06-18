<script lang="ts">
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import WelcomeStep from './steps/WelcomeStep.svelte';
	import SetupOverviewStep from './steps/SetupOverviewStep.svelte';
	import DownloadProgressStep from './steps/DownloadProgressStep.svelte';
	import PermissionsStep from './steps/PermissionsStep.svelte';

	// 4-Step Onboarding Flow (system-recommended models):
	// 1: Welcome — introduce muesly features
	// 2: Setup Overview — show recommended downloads
	// 3: Download Progress — download Parakeet + Gemma
	// 4: Permissions — request mic + system audio (macOS only)
	const platform = usePlatform();
</script>

<div class="onboarding-flow">
	{#if onboarding.currentStep === 1}
		<WelcomeStep />
	{:else if onboarding.currentStep === 2}
		<SetupOverviewStep />
	{:else if onboarding.currentStep === 3}
		<DownloadProgressStep />
	{:else if onboarding.currentStep === 4 && platform.isMac}
		<PermissionsStep />
	{/if}
</div>
