<script lang="ts">
	import { untrack } from 'svelte';

	import type { Transcript, TranscriptSegmentData } from '$lib/types';
	import { useSpeakerContext } from '$lib/hooks/use-speaker-context.svelte';
	import VirtualizedTranscriptView from '$lib/components/VirtualizedTranscriptView.svelte';
	import { Textarea } from '$lib/components/ui/textarea';
	import { cn } from '$lib/utils';
	import {
		sidePanelState,
		SIDE_PANEL_MIN_WIDTH,
		SIDE_PANEL_MAX_WIDTH,
		SIDE_PANEL_SUMMARY_MIN_WIDTH,
		type SidePanelTab,
	} from '$lib/stores/side-panel.svelte';
	import TranscriptButtonGroup from './TranscriptButtonGroup.svelte';
	import NotesView from './NotesView.svelte';

	interface Props {
		// Transcript
		transcripts: Transcript[];
		customPrompt: string;
		onPromptChange: (value: string) => void;
		onCopyTranscript: () => void;
		onOpenMeetingFolder: () => Promise<void>;
		isRecording: boolean;
		disableAutoScroll?: boolean;
		usePagination?: boolean;
		segments?: TranscriptSegmentData[];
		hasMore?: boolean;
		isLoadingMore?: boolean;
		totalCount?: number;
		loadedCount?: number;
		onLoadMore?: () => void;
		meetingId?: string;
		meetingFolderPath?: string | null;
		onRefetchTranscripts?: () => Promise<void>;

		// Notes
		notesMarkdown: string;
		onSaveNotes?: (data: { markdown: string }) => void | Promise<void>;
	}

	let {
		transcripts,
		customPrompt,
		onPromptChange,
		onCopyTranscript,
		onOpenMeetingFolder,
		isRecording,
		disableAutoScroll = false,
		usePagination = false,
		segments,
		hasMore,
		isLoadingMore,
		totalCount,
		loadedCount,
		onLoadMore,
		meetingId,
		meetingFolderPath,
		onRefetchTranscripts,
		notesMarkdown,
		onSaveNotes,
	}: Props = $props();

	// The notes editor stays mounted regardless of the active tab so unsaved edits
	// survive switching tabs (and collapsing the panel). The parent reads its
	// markdown for summary generation, so expose a thin pass-through API.
	let notesView = $state<ReturnType<typeof NotesView>>();
	export function getNotesMarkdown(): string {
		return notesView?.getMarkdown() ?? notesMarkdown;
	}
	export async function saveNotes(): Promise<void> {
		await notesView?.save();
	}

	function selectTab(tab: SidePanelTab): void {
		sidePanelState.activeTab = tab;
	}

	const convertedSegments = $derived.by((): TranscriptSegmentData[] => {
		if (usePagination && segments) return segments;
		return transcripts.map((t) => ({
			id: t.id,
			timestamp: t.audio_start_time ?? 0,
			endTime: t.audio_end_time,
			text: t.text,
			confidence: t.confidence,
			speaker: t.speaker,
			speaker_id: t.speaker_id,
		}));
	});

	const displayedCount = $derived(
		usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length ?? 0),
	);

	// Named-speaker context (assigned names, self name, attendee shortlist) for the
	// transcript labels, with its load/rename race handling encapsulated.
	const speakers = useSpeakerContext(
		() => meetingId,
		() => convertedSegments,
	);

	// Width lives in the session store (persists across meetings). The rendered
	// width is CSS-capped below, so a stale value can never overflow the row.
	let panelEl = $state<HTMLDivElement>();
	let isResizing = $state(false);

	// Largest width that still leaves the summary its minimum, from the actual
	// container width (not the window, which includes the sidebar).
	function maxWidth(): number {
		const available = panelEl?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
		return Math.max(
			SIDE_PANEL_MIN_WIDTH,
			Math.min(SIDE_PANEL_MAX_WIDTH, Math.round(available - SIDE_PANEL_SUMMARY_MIN_WIDTH)),
		);
	}

	function startResize(e: PointerEvent): void {
		e.preventDefault();
		// The container's bounds are fixed for the duration of the drag, so read
		// them once: only the summary/panel split changes, not the row itself.
		const rect = panelEl?.parentElement?.getBoundingClientRect();
		const rightEdge = rect?.right ?? window.innerWidth;
		const max = maxWidth();
		// A width carried over from a wider window could exceed what fits now;
		// snap it into range before dragging so the handle tracks the cursor.
		sidePanelState.width = Math.min(sidePanelState.width, max);
		isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const onMove = (ev: PointerEvent): void => {
			sidePanelState.width = Math.min(
				max,
				Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(rightEdge - ev.clientX)),
			);
		};
		const onUp = (): void => {
			isResizing = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// Keep the stored width within what fits the current window. The CSS cap
	// already bounds the rendered width, but this shrinks the persisted value too
	// (e.g. a width set on a wide window, then the window shrinks) so the resize
	// handle stays accurate and nothing relies on CSS percentage resolution.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const clamp = (): void =>
			untrack(() => {
				const max = maxWidth();
				if (sidePanelState.width > max) sidePanelState.width = max;
			});
		clamp();
		window.addEventListener('resize', clamp);
		return () => window.removeEventListener('resize', clamp);
	});

	const tabs: { id: SidePanelTab; label: string }[] = [
		{ id: 'transcript', label: 'Transcript' },
		{ id: 'notes', label: 'Notes' },
	];
</script>

<!-- `@container` makes the action labels respond to the PANEL width, not the
     viewport. `overflow-hidden` + the CSS width cap keep the panel within the
     window. The cap is declarative — `min(MAX, row − summary-min)` — so the
     rendered width can never exceed MAX even if the stored width is stale. -->
<div
	bind:this={panelEl}
	class={cn(
		'@container relative shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar',
		sidePanelState.open ? 'hidden md:flex' : 'hidden',
	)}
	style={`width: ${sidePanelState.width}px; max-width: min(${SIDE_PANEL_MAX_WIDTH}px, calc(100% - ${SIDE_PANEL_SUMMARY_MIN_WIDTH}px)); min-width: ${SIDE_PANEL_MIN_WIDTH}px`}
>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		role="separator"
		aria-orientation="vertical"
		aria-label="Resize side panel"
		class={cn(
			'absolute inset-y-0 -left-px z-10 w-1 cursor-col-resize transition-colors hover:bg-brand/40',
			isResizing && 'bg-brand/50',
		)}
		onpointerdown={startResize}
	></div>

	<!-- Tabs. The empty header space drags the window (overlay title bar); the tab
	     buttons block dragging on themselves. -->
	<div
		data-tauri-drag-region="deep"
		class="flex flex-shrink-0 items-center gap-1 border-b border-border px-3 pb-1 pt-7"
		role="tablist"
	>
		{#each tabs as tab (tab.id)}
			<button
				type="button"
				role="tab"
				aria-selected={sidePanelState.activeTab === tab.id}
				onclick={() => selectTab(tab.id)}
				class={cn(
					'relative rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
					sidePanelState.activeTab === tab.id
						? 'text-foreground'
						: 'text-muted-foreground hover:text-foreground',
				)}
			>
				{tab.label}
				{#if sidePanelState.activeTab === tab.id}
					<span class="absolute inset-x-2.5 -bottom-1 h-0.5 rounded-full bg-foreground"></span>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Transcript tab. Gated on `open` too so the virtualized list isn't mounted
	     inside a collapsed (display:none) panel, where it would measure to zero. -->
	{#if sidePanelState.open && sidePanelState.activeTab === 'transcript'}
		<div data-tauri-drag-region="deep" class="flex-shrink-0 p-3">
			<TranscriptButtonGroup
				transcriptCount={displayedCount}
				{onCopyTranscript}
				{onOpenMeetingFolder}
				{meetingId}
				{meetingFolderPath}
				{onRefetchTranscripts}
			/>
		</div>

		<div class="min-h-0 flex-1 overflow-hidden pb-4">
			<VirtualizedTranscriptView
				segments={convertedSegments}
				{isRecording}
				isPaused={false}
				isProcessing={false}
				isStopping={false}
				enableStreaming={false}
				showConfidence={true}
				{disableAutoScroll}
				hasMore={hasMore ?? false}
				isLoadingMore={isLoadingMore ?? false}
				totalCount={totalCount ?? 0}
				loadedCount={loadedCount ?? 0}
				{onLoadMore}
				showSpeakers={!isRecording && !!meetingId}
				speakerContext={speakers.ctx}
				onAssignSpeaker={!isRecording && meetingId ? speakers.assign : undefined}
			/>
		</div>

		{#if !isRecording && convertedSegments.length > 0}
			<div class="flex-shrink-0 border-t border-border p-1">
				<Textarea
					placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
					class="min-h-[80px] resize-y"
					value={customPrompt}
					oninput={(e) => onPromptChange(e.currentTarget.value)}
				/>
			</div>
		{/if}
	{/if}

	<!-- Notes tab: always mounted (hidden when inactive) to preserve unsaved edits. -->
	<div
		class={cn(
			'min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-3',
			sidePanelState.activeTab !== 'notes' && 'hidden',
		)}
	>
		<NotesView bind:this={notesView} {notesMarkdown} onSave={onSaveNotes} />
	</div>
</div>
