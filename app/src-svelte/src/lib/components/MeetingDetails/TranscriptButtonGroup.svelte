<script lang="ts">
	import { Copy, FolderOpen, RefreshCw } from '@lucide/svelte';

	import { Analytics } from '$lib/analytics';
	import Button from '$lib/ui/button.svelte';
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
		<Button
			variant="ghost"
			size="sm"
			class="text-muted-foreground hover:text-foreground"
			disabled={transcriptCount === 0}
			aria-label="Copy transcript"
			tooltip={transcriptCount === 0 ? 'No transcript available' : 'Copy Transcript'}
			onclick={() => {
				Analytics.trackButtonClick('copy_transcript', 'meeting_details');
				onCopyTranscript();
			}}
		>
			<Copy />
			<span class="hidden @[22rem]:inline">Copy</span>
		</Button>

		<Button
			variant="ghost"
			size="sm"
			class="text-muted-foreground hover:text-foreground @[28rem]:px-4"
			aria-label="Open recording folder"
			tooltip="Open Recording Folder"
			onclick={() => {
				Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
				void onOpenMeetingFolder();
			}}
		>
			<FolderOpen class="@[28rem]:mr-2" />
			<span class="hidden @[22rem]:inline">Recording</span>
		</Button>

		{#if canRetranscribe}
			<Button
				variant="outline"
				size="sm"
				class="border-accent/40 bg-accent/10 hover:bg-accent/20 @[28rem]:px-4"
				aria-label="Retranscribe"
				tooltip="Retranscribe to enhance your recorded audio"
				onclick={() => {
					Analytics.trackButtonClick('enhance_transcript', 'meeting_details');
					showRetranscribeDialog = true;
				}}
			>
				<RefreshCw class="@[28rem]:mr-2" />
				<span class="hidden @[22rem]:inline">Enhance</span>
			</Button>
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
