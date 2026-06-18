<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Check, Copy, Info, Loader2 } from '@lucide/svelte';

	import Button from '$lib/ui/button.svelte';
	import Switch from '$lib/ui/switch.svelte';
	import { Analytics } from '$lib/analytics';
	import { analyticsConsent } from '$lib/stores/analytics-consent.svelte';
	import AnalyticsDataModal from './AnalyticsDataModal.svelte';

	let isProcessing = $state(false);
	let showModal = $state(false);
	let userId = $state('');
	let isCopied = $state(false);

	// Keep the user ID display in sync with the opt-in state.
	$effect(() => {
		if (analyticsConsent.optedIn) {
			Analytics.getPersistentUserId()
				.then((id) => (userId = id))
				.catch((error) => console.error('Failed to load user ID:', error));
		} else {
			userId = '';
		}
	});

	async function handleCopyUserId(): Promise<void> {
		if (!userId) return;
		try {
			await navigator.clipboard.writeText(userId);
			isCopied = true;
			setTimeout(() => (isCopied = false), 2000);
			await Analytics.track('user_id_copied', { user_id: userId });
		} catch (error) {
			console.error('Failed to copy user ID:', error);
		}
	}

	async function handleToggle(enabled: boolean): Promise<void> {
		// Disabling requires confirmation via the transparency modal.
		if (!enabled) {
			showModal = true;
			try {
				await invoke('track_analytics_transparency_viewed');
			} catch (error) {
				console.error('Failed to track transparency view:', error);
			}
			return;
		}
		isProcessing = true;
		try {
			await analyticsConsent.setOptedIn(true);
		} finally {
			isProcessing = false;
		}
	}

	async function handleConfirmDisable(): Promise<void> {
		showModal = false;
		isProcessing = true;
		try {
			await analyticsConsent.setOptedIn(false);
		} finally {
			isProcessing = false;
		}
	}

	function handleCancelDisable(): void {
		showModal = false;
	}

	async function handlePrivacyPolicyClick(): Promise<void> {
		try {
			await invoke('open_external_url', {
				url: 'https://github.com/afonsojramos/muesly/blob/main/PRIVACY_POLICY.md'
			});
		} catch (error) {
			console.error('Failed to open privacy policy link:', error);
		}
	}
</script>

<div class="space-y-4">
	<div>
		<h3 class="mb-2 text-base font-semibold">Usage Analytics</h3>
		<p class="mb-4 text-sm text-muted-foreground">
			Help us improve muesly by sharing anonymous usage data. No personal content is collected —
			everything stays on your device.
		</p>
	</div>

	<div class="flex items-center justify-between rounded-lg border border-border bg-secondary/40 p-3">
		<div>
			<h4 class="font-semibold">Enable Analytics</h4>
			<p class="text-sm text-muted-foreground">
				{isProcessing ? 'Updating…' : 'Anonymous usage patterns only'}
			</p>
		</div>
		<div class="ml-4 flex items-center gap-2">
			{#if isProcessing}
				<Loader2 class="size-4 animate-spin text-muted-foreground" />
			{/if}
			<Switch checked={analyticsConsent.optedIn} disabled={isProcessing} onCheckedChange={handleToggle} />
		</div>
	</div>

	{#if analyticsConsent.optedIn && userId}
		<div class="rounded-lg border border-border bg-secondary/40 p-4">
			<div class="font-medium">Your User ID</div>
			<p class="mb-2 text-xs text-muted-foreground">
				Share this ID when reporting issues to help us investigate your issue logs
			</p>
			<div class="flex items-center gap-2">
				<code
					class="flex-1 truncate rounded border border-border bg-background px-2 py-1 font-mono text-xs"
				>
					{userId}
				</code>
				<Button variant="outline" size="sm" class="shrink-0" onclick={handleCopyUserId}>
					{#if isCopied}
						<Check class="size-3.5 text-green-600" /><span class="text-green-600">Copied!</span>
					{:else}
						<Copy class="size-3.5" /><span>Copy</span>
					{/if}
				</Button>
			</div>
		</div>
	{/if}

	<div class="flex items-start gap-2 rounded border border-accent/20 bg-accent/5 p-2">
		<Info class="mt-0.5 size-4 shrink-0 text-accent" />
		<div class="text-xs text-muted-foreground">
			<p class="mb-1">
				Your meetings, transcripts, and recordings remain completely private and local.
			</p>
			<button class="text-accent underline hover:no-underline" onclick={handlePrivacyPolicyClick}>
				View Privacy Policy
			</button>
		</div>
	</div>
</div>

<AnalyticsDataModal
	bind:open={showModal}
	onClose={handleCancelDisable}
	onConfirmDisable={handleConfirmDisable}
/>
