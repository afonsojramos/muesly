<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

	import { Analytics } from '$lib/analytics';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import DiarizationControl from './DiarizationControl.svelte';
	import RetranscribeDialog from './RetranscribeDialog.svelte';

	interface Props {
		transcriptCount: number;
		onCopyTranscript: () => void;
		onOpenMeetingFolder: () => Promise<void>;
		meetingId?: string;
		meetingFolderPath?: string | null;
		onRefetchTranscripts?: () => Promise<void>;
	}

	let {
		transcriptCount,
		onCopyTranscript,
		onOpenMeetingFolder,
		meetingId,
		meetingFolderPath,
		onRefetchTranscripts
	}: Props = $props();

	let showRetranscribeDialog = $state(false);

	const canRetranscribe = $derived(!!meetingId && !!meetingFolderPath);

	async function handleRetranscribeComplete(): Promise<void> {
		if (onRefetchTranscripts) await onRefetchTranscripts();
	}
</script>

<div class="flex w-full items-center justify-center gap-2">
	<div class="flex items-center gap-1">
		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="text-muted-foreground hover:text-foreground"
							disabled={transcriptCount === 0}
							aria-label="Copy transcript"
							onclick={() => {
								Analytics.trackButtonClick('copy_transcript', 'meeting_details');
								onCopyTranscript();
							}}
						>
							<CopyIcon data-icon="inline-start" />
							<span class="hidden @[22rem]:inline">Copy</span>
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>
					{transcriptCount === 0 ? 'No transcript available' : 'Copy Transcript'}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="text-muted-foreground hover:text-foreground @[28rem]:px-4"
							aria-label="Open recording folder"
							onclick={() => {
								Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
								void onOpenMeetingFolder();
							}}
						>
							<FolderOpenIcon data-icon="inline-start" />
							<span class="hidden @[22rem]:inline">Recording</span>
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Open Recording Folder</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		{#if canRetranscribe}
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="sm"
								class="border-accent/40 bg-accent/10 hover:bg-accent/20 @[28rem]:px-4"
								aria-label="Retranscribe"
								onclick={() => {
									Analytics.trackButtonClick('enhance_transcript', 'meeting_details');
									showRetranscribeDialog = true;
								}}
							>
								<RefreshCwIcon data-icon="inline-start" />
								<span class="hidden @[22rem]:inline">Enhance</span>
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Retranscribe to enhance your recorded audio</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		{/if}

		{#if meetingId && meetingFolderPath}
			<DiarizationControl {meetingId} onComplete={handleRetranscribeComplete} />
		{/if}
	</div>

	{#if canRetranscribe && meetingId && meetingFolderPath}
		<RetranscribeDialog
			bind:open={showRetranscribeDialog}
			onOpenChange={(o) => (showRetranscribeDialog = o)}
			{meetingId}
			{meetingFolderPath}
			onComplete={handleRetranscribeComplete}
		/>
	{/if}
</div>
