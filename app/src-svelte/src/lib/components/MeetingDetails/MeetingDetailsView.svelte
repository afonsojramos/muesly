<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PanelRightCloseIcon from '@lucide/svelte/icons/panel-right-close';
	import PanelRightOpenIcon from '@lucide/svelte/icons/panel-right-open';

	import type { Summary, Transcript, TranscriptSegmentData } from '$lib/types';
	import type { ModelConfig } from '$lib/services/config';
	import { Analytics } from '$lib/analytics';
	import { config } from '$lib/stores/config.svelte';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import { sidePanelState } from '$lib/stores/side-panel.svelte';
	import { summaryLanguage } from '$lib/stores/summary-language.svelte';
	import { debounce } from '$lib/utils/debounce';
	import { toast } from '$lib/toast';
	import { storageService } from '$lib/services/storage';
	import { useMeetingData } from '$lib/hooks/use-meeting-data.svelte';
	import { useTemplates } from '$lib/hooks/use-templates.svelte';
	import { useCopyOperations } from '$lib/hooks/use-copy-operations.svelte';
	import { useMeetingOperations } from '$lib/hooks/use-meeting-operations.svelte';
	import { useSummaryGeneration } from '$lib/hooks/use-summary-generation.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import SidePanel from './SidePanel.svelte';
	import SummaryPanel from './SummaryPanel.svelte';

	interface MeetingDetailsData {
		id: string;
		title: string;
		created_at: string;
		updated_at?: string;
		transcripts: Transcript[];
		folder_path?: string | null;
	}

	interface Props {
		meeting: MeetingDetailsData;
		summaryData: Summary | null;
		/** The user's saved in-meeting notes (markdown). */
		notesMarkdown?: string;
		/** Persisted per-meeting context that steers AI summary generation. */
		summaryContext?: string;
		shouldAutoGenerate?: boolean;
		onAutoGenerateComplete?: () => void;
		onMeetingUpdated?: () => Promise<void>;
		onRefetchTranscripts?: () => Promise<void>;
		segments?: TranscriptSegmentData[];
		hasMore?: boolean;
		isLoadingMore?: boolean;
		totalCount?: number;
		loadedCount?: number;
		onLoadMore?: () => void;
	}

	let {
		meeting,
		summaryData,
		notesMarkdown = '',
		summaryContext = '',
		shouldAutoGenerate = false,
		onAutoGenerateComplete,
		onMeetingUpdated,
		onRefetchTranscripts,
		segments,
		hasMore,
		isLoadingMore,
		totalCount,
		loadedCount,
		onLoadMore,
	}: Props = $props();

	// Seeded from the persisted summary context; this subtree is keyed by meeting
	// id (see meeting-details/+page.svelte), so it re-seeds when switching meetings.
	// svelte-ignore state_referenced_locally
	let customPrompt = $state(summaryContext);
	const isRecording = false;

	// Custom prompt auto-save: debounce while typing, flush on teardown so a
	// freshly typed context isn't lost when switching meetings. Mirrors the title
	// auto-save below. Does not block the UI; failures surface via toast.
	async function saveSummaryContextNow(): Promise<void> {
		saveStatus.begin();
		try {
			await storageService.saveMeetingSummaryContext(meeting.id, customPrompt);
			saveStatus.end(true);
		} catch (e) {
			saveStatus.end(false);
			toast.error('Failed to save summary context', { description: String(e) });
		}
	}
	const debouncedSaveContext = debounce(() => void saveSummaryContextNow(), 800);
	onDestroy(() => debouncedSaveContext.flush());

	function handlePromptChange(value: string): void {
		customPrompt = value;
		debouncedSaveContext();
	}

	// Side panel open/tab/width live in a session store above this view, so they
	// persist while navigating between meetings (this subtree remounts per id).
	let sidePanel = $state<ReturnType<typeof SidePanel>>();

	// Title is a click-to-edit field: a truncating label when idle (so long
	// auto-generated titles don't clip mid-word), an input while editing.
	let isEditingTitle = $state(false);
	let titleInputEl = $state<HTMLInputElement>();
	function startEditTitle(): void {
		isEditingTitle = true;
		queueMicrotask(() => {
			titleInputEl?.focus();
			titleInputEl?.select();
		});
	}
	function stopEditTitle(): void {
		isEditingTitle = false;
		debouncedSaveTitle.flush();
	}

	// Title auto-save: debounce while typing; flush on blur (Enter/Escape blur
	// too) and on teardown so a rename isn't lost when switching meetings.
	let titleSaving = false;
	async function saveTitleNow(): Promise<void> {
		if (!meetingData.isTitleDirty || titleSaving) return;
		titleSaving = true;
		saveStatus.begin();
		try {
			const ok = await meetingData.handleSaveMeetingTitle();
			saveStatus.end(ok);
			if (!ok) toast.error('Failed to save title');
		} catch (e) {
			saveStatus.end(false);
			toast.error('Failed to save title', { description: String(e) });
		} finally {
			titleSaving = false;
		}
	}
	const debouncedSaveTitle = debounce(() => void saveTitleNow(), 800);
	onDestroy(() => debouncedSaveTitle.flush());

	async function handleSaveNotes(data: { markdown: string }): Promise<void> {
		await storageService.saveMeetingNotes(meeting.id, data.markdown);
	}

	// Switch summary templates "in place": picking a new template regenerates the
	// summary with it (true reformatting without re-running the LLM isn't possible).
	async function handleTemplateSelect(templateId: string, templateName: string): Promise<void> {
		const changed = templateId !== templates.selectedTemplate;
		templates.handleTemplateSelection(templateId, templateName);
		if (changed && meetingData.aiSummary) {
			await summaryGeneration.handleGenerateSummary(customPrompt);
		}
	}

	// Export the note (title + AI summary) to a Markdown file via a native Save
	// dialog. The backend writes the file and returns the chosen path.
	async function handleExport(): Promise<void> {
		try {
			const summaryMarkdown = (await summaryPanel?.getSummaryMarkdown()) ?? '';
			const title = meetingData.meetingTitle?.trim() || 'Untitled meeting';
			const contents = `# ${title}\n\n${summaryMarkdown}`.trim() + '\n';
			const safeName = (title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'meeting') + '.md';

			const savedPath = await invoke<string | null>('api_export_meeting_markdown', {
				defaultFileName: safeName,
				contents,
			});
			if (savedPath) {
				toast.success('Note exported', { description: savedPath });
				void Analytics.trackButtonClick('export_note', 'meeting_details');
			}
		} catch (error) {
			console.error('Failed to export note:', error);
			toast.error('Failed to export note', { description: String(error) });
		}
	}

	const createdDate = $derived(new Date(meeting.created_at));

	let openModelSettings: (() => void) | null = null;
	let summaryPanel = $state<ReturnType<typeof SummaryPanel>>();

	// This component is keyed by `meeting.id` upstream, so re-initializing the
	// hooks with the current props on each meeting is exactly what we want.
	// svelte-ignore state_referenced_locally
	const meetingData = useMeetingData({ meeting, summaryData });
	const templates = useTemplates();

	function handleRegisterModalOpen(openFn: () => void): void {
		openModelSettings = openFn;
	}

	function handleOpenModelSettings(): void {
		if (openModelSettings) {
			openModelSettings();
		} else {
			console.warn('Model settings open function not yet registered');
		}
	}

	async function handleSaveModelConfig(configToSave?: ModelConfig): Promise<void> {
		if (!configToSave) return;
		try {
			await invoke('api_save_model_config', {
				provider: configToSave.provider,
				model: configToSave.model,
				whisperModel: configToSave.whisperModel,
				apiKey: configToSave.apiKey ?? null,
				ollamaEndpoint: configToSave.ollamaEndpoint ?? null,
			});
			await emit('model-config-updated', configToSave);
			toast.success('Model settings saved successfully');
		} catch (error) {
			console.error('Failed to save model config:', error);
			toast.error('Failed to save model settings');
		}
	}

	const summaryGeneration = useSummaryGeneration({
		getMeeting: () => meeting,
		getModelConfig: () => config.modelConfig,
		getIsModelConfigLoading: () => false,
		getSelectedTemplate: () => templates.selectedTemplate,
		getSummaryLanguage: () => summaryLanguage.preferred,
		// Live notes from the always-mounted editor. The prop fallback only covers
		// the first synchronous render tick before bind:this resolves.
		getNotesMarkdown: () => sidePanel?.getNotesMarkdown() ?? notesMarkdown,
		// svelte-ignore state_referenced_locally
		onMeetingUpdated,
		updateMeetingTitle: meetingData.updateMeetingTitle,
		setAiSummary: meetingData.setAiSummary,
		onOpenModelSettings: handleOpenModelSettings,
	});

	const copyOperations = useCopyOperations({
		// svelte-ignore state_referenced_locally
		meeting,
		getMeetingTitle: () => meetingData.meetingTitle,
		getAiSummary: () => meetingData.aiSummary,
		getSummaryMarkdown: async () => summaryPanel?.getSummaryMarkdown() ?? '',
	});

	// svelte-ignore state_referenced_locally
	const meetingOperations = useMeetingOperations(meeting);

	async function handleSaveSummary(data: { markdown: string }): Promise<void> {
		await meetingData.handleSaveSummary(data);
	}

	onMount(() => {
		void Analytics.trackPageView('meeting_details');
		// Clear any lingering "Saved" flash from the previously viewed meeting.
		saveStatus.reset();

		// ⌘T toggles the side panel, matching the tooltip hint.
		const handleKeydown = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
				e.preventDefault();
				sidePanelState.toggle();
			}
		};
		window.addEventListener('keydown', handleKeydown);

		// Live-update the title when the backend auto-generates one after a
		// meeting (generation may finish after we've already navigated here).
		let unlistenTitle: UnlistenFn | undefined;
		let cancelled = false;
		void listen<{ meeting_id: string; title: string }>('meeting-title-updated', (event) => {
			if (event.payload.meeting_id === meeting.id && event.payload.title) {
				meetingData.updateMeetingTitle(event.payload.title);
			}
		}).then((fn) => {
			if (cancelled) fn();
			else unlistenTitle = fn;
		});

		return () => {
			window.removeEventListener('keydown', handleKeydown);
			cancelled = true;
			unlistenTitle?.();
		};
	});

	// Auto-generate the summary once when requested for a freshly recorded meeting.
	let autoGenStartedFor: string | null = null;
	$effect(() => {
		const id = meeting.id;
		if (shouldAutoGenerate && meeting.transcripts.length > 0 && autoGenStartedFor !== id) {
			autoGenStartedFor = id;
			void (async () => {
				await summaryGeneration.handleGenerateSummary('');
				onAutoGenerateComplete?.();
			})();
		}
	});
</script>

<div in:fly={{ y: 20, duration: 300 }} class="flex h-screen flex-col bg-background">
	<div class="flex flex-1 overflow-hidden">
		<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
			<!-- Note header: large display title + date, Granola-style. Empty
			     areas drag the window (overlay title bar); the title input and
			     toggle button block dragging on themselves. -->
			<div data-tauri-drag-region="deep" class="flex-shrink-0 px-8 pb-1 pt-7">
				<div class="flex items-start gap-2">
					{#if isEditingTitle}
						<Input
							bind:ref={titleInputEl}
							type="text"
							value={meetingData.meetingTitle}
							oninput={(e) => {
								meetingData.handleTitleChange(e.currentTarget.value);
								debouncedSaveTitle();
							}}
							onblur={stopEditTitle}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
							}}
							placeholder="Untitled meeting"
							class="h-auto min-w-0 flex-1 border-none bg-transparent p-0 font-display text-3xl font-medium shadow-none focus-visible:ring-0 md:text-3xl placeholder:text-muted-foreground/50"
						/>
					{:else}
						<button
							type="button"
							onclick={startEditTitle}
							class="min-w-0 flex-1 truncate text-left font-display text-3xl font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="Edit meeting title"
						>
							{#if meetingData.meetingTitle?.trim()}
								{meetingData.meetingTitle}
							{:else}
								<span class="text-muted-foreground/50">Untitled meeting</span>
							{/if}
						</button>
					{/if}
					<Tooltip.Provider delayDuration={300}>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										onclick={handleExport}
										class="mt-1.5 flex-shrink-0 text-muted-foreground hover:text-foreground"
										aria-label="Export note as Markdown"
									>
										<DownloadIcon />
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>Export as Markdown</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
					<Tooltip.Provider delayDuration={300}>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										onclick={() => sidePanelState.toggle()}
										class="mt-1.5 flex-shrink-0 text-muted-foreground hover:text-foreground"
										aria-label={sidePanelState.open
											? 'Hide transcript & notes'
											: 'Show transcript & notes'}
										aria-pressed={sidePanelState.open}
									>
										{#if sidePanelState.open}
											<PanelRightCloseIcon />
										{:else}
											<PanelRightOpenIcon />
										{/if}
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>
								<span class="flex items-center">
									{sidePanelState.open ? 'Hide transcript & notes' : 'Show transcript & notes'}
									<span class="ml-1.5 tracking-wide opacity-60">⌘T</span>
								</span>
							</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
				</div>
				{#if !isNaN(createdDate.getTime())}
					<p class="mt-1 text-sm text-muted-foreground">
						{createdDate.toLocaleDateString(undefined, {
							weekday: 'long',
							month: 'long',
							day: 'numeric',
						})} · {createdDate.toLocaleTimeString(undefined, {
							hour: 'numeric',
							minute: '2-digit',
						})}
					</p>
				{/if}
			</div>
			<SummaryPanel
				bind:this={summaryPanel}
				onCopySummary={copyOperations.handleCopySummary}
				onOpenFolder={meetingOperations.openMeetingFolder}
				aiSummary={meetingData.aiSummary}
				summaryStatus={summaryGeneration.summaryStatus}
				transcripts={meeting.transcripts}
				modelConfig={config.modelConfig}
				setModelConfig={(c) => (config.modelConfig = c)}
				onSaveModelConfig={handleSaveModelConfig}
				onGenerateSummary={summaryGeneration.handleGenerateSummary}
				onStopGeneration={summaryGeneration.handleStopGeneration}
				{customPrompt}
				onSaveSummary={handleSaveSummary}
				summaryError={summaryGeneration.summaryError}
				onRegenerateSummary={summaryGeneration.handleRegenerateSummary}
				availableTemplates={templates.availableTemplates}
				selectedTemplate={templates.selectedTemplate}
				onTemplateSelect={handleTemplateSelect}
				isModelConfigLoading={false}
				onOpenModelSettings={handleRegisterModalOpen}
			/>
		</div>
		<!-- Combined Transcript / Notes panel. Always mounted so the notes editor
		     keeps unsaved edits across collapsing; open/tab/width come from the
		     session store so they persist across meetings. -->
		<SidePanel
			bind:this={sidePanel}
			transcripts={meeting.transcripts}
			{customPrompt}
			onPromptChange={handlePromptChange}
			onCopyTranscript={copyOperations.handleCopyTranscript}
			onOpenMeetingFolder={meetingOperations.openMeetingFolder}
			{isRecording}
			disableAutoScroll={true}
			usePagination={true}
			{segments}
			{hasMore}
			{isLoadingMore}
			{totalCount}
			{loadedCount}
			{onLoadMore}
			meetingId={meeting.id}
			meetingFolderPath={meeting.folder_path}
			{onRefetchTranscripts}
			{notesMarkdown}
			onSaveNotes={handleSaveNotes}
		/>
	</div>
</div>
