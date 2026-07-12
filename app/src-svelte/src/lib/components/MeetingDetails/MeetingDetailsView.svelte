<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { mergeProps } from 'bits-ui';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EllipsisVerticalIcon from '@lucide/svelte/icons/ellipsis-vertical';
	import PanelRightCloseIcon from '@lucide/svelte/icons/panel-right-close';
	import PanelRightOpenIcon from '@lucide/svelte/icons/panel-right-open';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	import type { Summary, Transcript, TranscriptSegmentData } from '$lib/types';
	import type { ModelConfig } from '$lib/services/config';
	import { Analytics } from '$lib/analytics';
	import { cn } from '$lib/utils';
	import { config } from '$lib/stores/config.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import { sidePanelState } from '$lib/stores/side-panel.svelte';
	import { summaryLanguage } from '$lib/stores/summary-language.svelte';
	import { findSegmentNearTime } from '$lib/transcript-link';
	import { debounce } from '$lib/utils/debounce';
	import { toast } from '$lib/toast';
	import { storageService } from '$lib/services/storage';
	import { useMeetingData } from '$lib/hooks/use-meeting-data.svelte';
	import { useTemplates } from '$lib/hooks/use-templates.svelte';
	import {
		fetchAllTranscripts,
		fetchSpeakerContext,
		transcriptMarkdownBody,
		useCopyOperations,
	} from '$lib/hooks/use-copy-operations.svelte';
	import { useMeetingOperations } from '$lib/hooks/use-meeting-operations.svelte';
	import { useSummaryGeneration } from '$lib/hooks/use-summary-generation.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
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

	/** Calendar shortlist + self for header chips. */
	let attendeeChips = $state<string[]>([]);
	$effect(() => {
		const id = meeting.id;
		void (async () => {
			try {
				const res = await (await import('$lib/bindings')).commands.getMeetingSpeakers(id);
				if (res.status !== 'ok') return;
				const chips: string[] = [];
				if (res.data.self_name?.trim()) chips.push(res.data.self_name.trim());
				for (const n of res.data.shortlist) {
					if (n.trim() && !chips.includes(n.trim())) chips.push(n.trim());
				}
				attendeeChips = chips.slice(0, 12);
			} catch {
				attendeeChips = [];
			}
		})();
	});

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

	// Export the note (title + AI summary + speaker-labeled transcript) to a
	// Markdown file via a native Save dialog. The backend writes the file and
	// returns the chosen path. A meeting with no transcript exports summary-only.
	async function handleExportMarkdown(): Promise<void> {
		try {
			const summaryMarkdown = (await summaryPanel?.getSummaryMarkdown()) ?? '';
			const title = meetingData.meetingTitle?.trim() || 'Untitled meeting';
			let contents = `# ${title}\n\n${summaryMarkdown}`.trim();
			const rows = await fetchAllTranscripts(meeting.id);
			if (rows.length > 0) {
				const ctx = await fetchSpeakerContext(meeting.id);
				contents += `\n\n## Transcript\n\n${transcriptMarkdownBody(rows, ctx)}`;
			}
			contents = contents.trim() + '\n';
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

	async function handleCopyNotes(): Promise<void> {
		try {
			const notes = (sidePanel?.getNotesMarkdown() ?? notesMarkdown).trim();
			if (!notes) {
				toast.error('No notes to copy');
				return;
			}
			await navigator.clipboard.writeText(notes);
			toast.success('Notes copied to clipboard');
			void Analytics.trackButtonClick('copy_notes', 'meeting_details');
		} catch (error) {
			console.error('Failed to copy notes:', error);
			toast.error('Failed to copy notes', { description: String(error) });
		}
	}

	let deleteConfirmOpen = $state(false);
	let deleting = $state(false);

	// Closing the actions menu restores focus to the trigger, which the tooltip
	// treats as a reason to open. Gate it: ignore open requests while the menu
	// is open or just closed; a fresh hover (pointerenter) re-arms it.
	let actionsMenuOpen = $state(false);
	let actionsTooltipOpen = $state(false);
	let suppressActionsTooltip = $state(false);

	function handleActionsMenuOpenChange(open: boolean): void {
		actionsMenuOpen = open;
		actionsTooltipOpen = false;
		if (!open) suppressActionsTooltip = true;
	}

	function handleActionsTooltipOpenChange(open: boolean): void {
		if (open && (actionsMenuOpen || suppressActionsTooltip)) return;
		actionsTooltipOpen = open;
	}

	async function handleDeleteMeeting(): Promise<void> {
		if (deleting) return;
		deleting = true;
		const meetingId = meeting.id;
		try {
			await invoke('api_delete_meeting', { meetingId });
			sidebar.meetings = sidebar.meetings.filter((m) => m.id !== meetingId);
			void Analytics.trackMeetingDeleted(meetingId);
			toast.success('Meeting moved to trash', {
				description: 'Restore it from Settings → Trash',
				action: {
					label: 'Undo',
					onClick: () => {
						void (async () => {
							try {
								await invoke('api_restore_meeting', { meetingId });
								await sidebar.refetchMeetings();
							} catch (error) {
								console.error('Failed to restore meeting:', error);
							}
						})();
					},
				},
			});
			deleteConfirmOpen = false;
			if (sidebar.currentMeeting?.id === meetingId) {
				sidebar.setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
			}
			void goto('/');
		} catch (error) {
			console.error('Failed to delete meeting:', error);
			toast.error('Failed to delete meeting', {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			deleting = false;
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

	/** Summary `[mm:ss]` click → open transcript panel on the nearest segment. */
	function handleTimestampClick(seconds: number): void {
		const pool = (segments ?? meeting.transcripts ?? []).map((s) => ({
			id: s.id,
			text: 'text' in s ? String(s.text) : '',
			audio_start_time:
				'audio_start_time' in s
					? (s.audio_start_time as number | null | undefined)
					: 'timestamp' in s && typeof s.timestamp === 'number'
						? s.timestamp
						: null,
		}));
		const hit = findSegmentNearTime(pool, seconds);
		if (hit) {
			sidePanelState.jumpToSegment(hit.id);
		} else {
			sidePanelState.open = true;
			sidePanelState.activeTab = 'transcript';
			toast.info('No matching transcript moment', {
				description: 'Try regenerating the summary with timestamps, or open the transcript panel.',
			});
		}
	}

	onMount(() => {
		void Analytics.trackPageView('meeting_details');
		// Clear any lingering "Saved" flash from the previously viewed meeting.
		saveStatus.reset();

		// ⌘T toggles the side panel; ⌘[ navigates back, matching the tooltip hints.
		const handleKeydown = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
				e.preventDefault();
				sidePanelState.toggle();
			}
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '[') {
				e.preventDefault();
				history.back();
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
			<!-- Slim top bar: back on the left, note actions on the right, matching the
			     folder and settings views. -->
			<div class="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm">
				<div
					data-tauri-drag-region="deep"
					class={cn(
						'relative flex h-9 items-center gap-1 pr-3 transition-[padding] duration-300',
						sidebar.isCollapsed ? 'pl-[6.5rem]' : 'pl-3',
					)}
				>
					<Tooltip.Provider delayDuration={300}>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										onclick={() => history.back()}
										variant="ghost"
										size="icon-sm"
										class="text-muted-foreground hover:text-foreground"
										aria-label="Back"
									>
										<ArrowLeftIcon />
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>
								Back
								<span class="tracking-wide opacity-60">⌘[</span>
							</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
					<div class="ml-auto flex items-center gap-1">
						<DropdownMenu.Root open={actionsMenuOpen} onOpenChange={handleActionsMenuOpenChange}>
							<Tooltip.Provider delayDuration={300}>
								<Tooltip.Root
									open={actionsTooltipOpen}
									onOpenChange={handleActionsTooltipOpenChange}
								>
									<Tooltip.Trigger>
										{#snippet child({ props: tooltipProps })}
											<DropdownMenu.Trigger>
												{#snippet child({ props: menuProps })}
													<Button
														{...mergeProps(tooltipProps, menuProps, {
															onpointerenter: () => (suppressActionsTooltip = false),
														})}
														variant="ghost"
														size="icon-sm"
														class="text-muted-foreground hover:text-foreground"
														aria-label="Meeting actions"
													>
														<EllipsisVerticalIcon />
													</Button>
												{/snippet}
											</DropdownMenu.Trigger>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content>Meeting actions</Tooltip.Content>
								</Tooltip.Root>
							</Tooltip.Provider>
							<DropdownMenu.Content align="end" class="min-w-48">
								<DropdownMenu.Item onSelect={() => void handleCopyNotes()}>
									<CopyIcon />
									Copy notes
								</DropdownMenu.Item>
								<DropdownMenu.Item onSelect={() => void handleExportMarkdown()}>
									<DownloadIcon />
									Export as Markdown
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="destructive"
									onSelect={() => {
										deleteConfirmOpen = true;
									}}
								>
									<Trash2Icon />
									Delete meeting
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
						<Tooltip.Provider delayDuration={300}>
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											onclick={() => sidePanelState.toggle()}
											class="text-muted-foreground hover:text-foreground"
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
				</div>
			</div>
			<!-- Note header: large display title + date, Granola-style. -->
			<div data-tauri-drag-region="deep" class="flex-shrink-0 px-8 pb-1 pt-4">
				<div class="flex items-start gap-1">
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
				{#if attendeeChips.length > 0}
					<div class="mt-3 flex flex-wrap gap-1.5" aria-label="Attendees">
						{#each attendeeChips as name (name)}
							<span
								class="inline-flex max-w-[12rem] items-center truncate rounded-full border border-border bg-secondary/60 px-2.5 py-0.5 text-xs text-foreground"
								title={name}
							>
								{name}
							</span>
						{/each}
					</div>
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
				onTimestampClick={handleTimestampClick}
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

<Dialog.Root bind:open={deleteConfirmOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete meeting</Dialog.Title>
			<Dialog.Description>
				Move this meeting to the trash? You can restore it from Settings → Trash.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteConfirmOpen = false)} disabled={deleting}>
				Cancel
			</Button>
			<Button variant="destructive" onclick={() => void handleDeleteMeeting()} disabled={deleting}>
				{deleting ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
