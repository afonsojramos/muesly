<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';

	import { Analytics } from '$lib/analytics';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

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
			<Loader2Icon class="size-3.5 animate-spin" />
			<span class="hidden lg:inline">Saving…</span>
		</span>
	{:else if saveStatus.state === 'saved'}
		<span
			role="status"
			aria-live="polite"
			class="flex items-center gap-1 px-2 text-xs text-muted-foreground"
		>
			<CheckIcon class="size-3.5" />
			<span class="hidden lg:inline">Saved</span>
		</span>
	{/if}

	<Tooltip.Provider delayDuration={300}>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="text-muted-foreground hover:text-foreground"
						aria-label="Copy summary"
						disabled={!hasSummary}
						onclick={() => {
							Analytics.trackButtonClick('copy_summary', 'meeting_details');
							void onCopy();
						}}
					>
						<CopyIcon data-icon="inline-start" />
						<span class="hidden lg:inline">Copy</span>
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Copy Summary</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
</div>
