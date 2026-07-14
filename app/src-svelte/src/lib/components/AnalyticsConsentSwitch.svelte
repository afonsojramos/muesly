<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Check, Copy, Info, Loader2 } from '@lucide/svelte';

	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
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
				url: 'https://github.com/afonsojramos/muesly/blob/main/PRIVACY_POLICY.md',
			});
		} catch (error) {
			console.error('Failed to open privacy policy link:', error);
		}
	}
</script>

<div class="flex flex-col gap-3">
	<div class="flex min-h-10 items-center justify-between gap-4">
		<div>
			<h4 id="usage-analytics-label" class="font-medium">Share anonymous usage</h4>
			<p class="text-sm text-muted-foreground">
				{isProcessing ? 'Updating…' : 'Feature usage and performance only—never meeting content'}
			</p>
		</div>
		<div class="ml-4 flex items-center gap-2">
			{#if isProcessing}
				<Loader2 class="size-4 animate-spin text-muted-foreground" />
			{/if}
			<Switch
				checked={analyticsConsent.optedIn}
				disabled={isProcessing}
				aria-labelledby="usage-analytics-label"
				onCheckedChange={handleToggle}
			/>
		</div>
	</div>

	{#if analyticsConsent.optedIn && userId}
		<div class="rounded-lg bg-muted/40 p-3">
			<div class="font-medium">Your support ID</div>
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
						<Check data-icon="inline-start" class="text-success" /><span class="text-success"
							>Copied!</span
						>
					{:else}
						<Copy data-icon="inline-start" /><span>Copy</span>
					{/if}
				</Button>
			</div>
		</div>
	{/if}

	<div class="flex items-start gap-2 rounded-lg bg-muted/50 p-3">
		<Info class="mt-0.5 size-4 shrink-0 text-foreground" />
		<div class="text-xs text-muted-foreground">
			<p class="mb-1">
				Your meetings, transcripts, and recordings remain completely private and local.
			</p>
			<Button variant="link" size="xs" class="h-auto p-0" onclick={handlePrivacyPolicyClick}>
				View privacy policy
			</Button>
		</div>
	</div>
</div>

<AnalyticsDataModal
	bind:open={showModal}
	onClose={handleCancelDisable}
	onConfirmDisable={handleConfirmDisable}
/>
