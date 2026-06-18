<script lang="ts">
	import { Check, Copy, Loader2 } from '@lucide/svelte';

	import { Analytics } from '$lib/analytics';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import Button from '$lib/ui/button.svelte';

	interface Props {
		onCopy: () => Promise<void>;
		hasSummary: boolean;
	}

	let { onCopy, hasSummary }: Props = $props();
</script>

<div class="flex items-center gap-1">
	<!-- Auto-save status (replaces the old Save button). -->
	{#if saveStatus.state === 'saving'}
		<span
			role="status"
			aria-live="polite"
			class="flex items-center gap-1 px-2 text-xs text-muted-foreground"
		>
			<Loader2 class="size-3.5 animate-spin" />
			<span class="hidden lg:inline">Saving…</span>
		</span>
	{:else if saveStatus.state === 'saved'}
		<span
			role="status"
			aria-live="polite"
			class="flex items-center gap-1 px-2 text-xs text-muted-foreground"
		>
			<Check class="size-3.5" />
			<span class="hidden lg:inline">Saved</span>
		</span>
	{/if}

	<Button
		variant="ghost"
		size="sm"
		class="cursor-pointer text-muted-foreground hover:text-foreground"
		aria-label="Copy summary"
		tooltip="Copy Summary"
		disabled={!hasSummary}
		onclick={() => {
			Analytics.trackButtonClick('copy_summary', 'meeting_details');
			void onCopy();
		}}
	>
		<Copy />
		<span class="hidden lg:inline">Copy</span>
	</Button>
</div>
