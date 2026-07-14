<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { goto } from '$app/navigation';
	import { onDestroy, onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { mergeProps } from 'bits-ui';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EllipsisVerticalIcon from '@lucide/svelte/icons/ellipsis-vertical';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import SquareIcon from '@lucide/svelte/icons/square';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UsersIcon from '@lucide/svelte/icons/users';

	import type { Summary, Transcript, TranscriptSegmentData } from '$lib/types';
	import type { ModelConfig } from '$lib/services/config';
	import { Analytics } from '$lib/analytics';
	import { cn } from '$lib/utils';
	import { config } from '$lib/stores/config.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { saveStatus } from '$lib/stores/save-status.svelte';
	import { sidePanelState } from '$lib/stores/side-panel.svelte';
	import { summaryLanguage } from '$lib/stores/summary-language.svelte';
	import { AUTO_SUMMARY_LANGUAGE, SUMMARY_LANGUAGES } from '$lib/summary-languages';
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
	import SummaryPanel from './SummaryPanel.svelte';
	import NotesView from './NotesView.svelte';

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
				attendeeChips = chips;
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

	let notesView = $state<ReturnType<typeof NotesView>>();
	let notesMode = $state<'enhanced' | 'notes'>('enhanced');

	// Title is a click-to-edit field: a truncating label when idle (so long
	// auto-generated titles don't clip mid-word), an input while editing.
	let isEditingTitle = $state(false);
	let titleInputEl = $state<HTMLInputElement | null>(null);
	let titleIsTruncated = $state(false);
	function observeTitleOverflow(node: HTMLElement): { destroy: () => void } {
		const update = () => {
			titleIsTruncated = node.scrollWidth > node.clientWidth + 1;
		};
		const resizeObserver = new ResizeObserver(update);
		const mutationObserver = new MutationObserver(update);
		resizeObserver.observe(node);
		mutationObserver.observe(node, { childList: true, characterData: true, subtree: true });
		queueMicrotask(update);
		return {
			destroy: () => {
				resizeObserver.disconnect();
				mutationObserver.disconnect();
			},
		};
	}
	async function startEditTitle(): Promise<void> {
		isEditingTitle = true;
		await tick();
		titleInputEl?.focus();
		titleInputEl?.select();
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
			const notes = (notesView?.getMarkdown() ?? notesMarkdown).trim();
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

	// Opening the actions menu, and the focus restore when it closes, both make
	// the tooltip open (or stick). bits-ui components own their state unless
	// bind:open is used, so bind both and force the tooltip shut while the menu
	// is open or was just closed; a fresh hover (pointerenter) re-arms.
	let actionsMenuOpen = $state(false);
	// Button's bindable `ref` prop has a fallback, so Svelte requires an explicit
	// nullable value here. `undefined` throws while this view mounts and leaves the
	// route's previous loading state visible indefinitely.
	let actionsButtonEl = $state<HTMLButtonElement | null>(null);
	let actionsTooltipOpen = $state(false);
	let suppressActionsTooltip = $state(false);

	$effect(() => {
		if (actionsMenuOpen) suppressActionsTooltip = true;
	});

	function openModelSettingsFromMenu(): void {
		// Let the dropdown close and restore its trigger before opening the dialog,
		// so closing Model Settings returns focus to a stable visible control.
		setTimeout(() => {
			actionsButtonEl?.focus();
			summaryPanel?.openSummarySettings();
		}, 0);
	}
	$effect(() => {
		if (actionsTooltipOpen && (actionsMenuOpen || suppressActionsTooltip)) {
			actionsTooltipOpen = false;
		}
	});

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
								toast.error('Failed to restore meeting', {
									description: error instanceof Error ? error.message : String(error),
								});
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
		getNotesMarkdown: () => notesView?.getMarkdown() ?? notesMarkdown,
		// svelte-ignore state_referenced_locally
		onMeetingUpdated,
		updateMeetingTitle: meetingData.updateMeetingTitle,
		setAiSummary: meetingData.setAiSummary,
		onOpenModelSettings: handleOpenModelSettings,
	});
	const isSummaryGenerating = $derived(
		['processing', 'cleanup', 'summarizing', 'regenerating'].includes(
			summaryGeneration.summaryStatus,
		),
	);

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

	/** Summary `[mm:ss]` click → open the transcript drop-up on the nearest segment. */
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
				description: 'Try regenerating the summary with timestamps, or open the transcript.',
			});
		}
	}

	onMount(() => {
		void Analytics.trackPageView('meeting_details');
		// Clear any lingering "Saved" flash from the previously viewed meeting.
		saveStatus.reset();

		// ⌘T toggles the transcript drop-up; ⌘[ navigates back.
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
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
						<DropdownMenu.Root bind:open={actionsMenuOpen}>
							<Tooltip.Provider delayDuration={300}>
								<Tooltip.Root bind:open={actionsTooltipOpen}>
									<Tooltip.Trigger>
										{#snippet child({ props: tooltipProps })}
											<DropdownMenu.Trigger>
												{#snippet child({ props: menuProps })}
													<Button
														bind:ref={actionsButtonEl}
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
								<DropdownMenu.Item
									disabled={meeting.transcripts.length === 0}
									onSelect={() => void summaryPanel?.triggerSummaryAction()}
								>
									{#if isSummaryGenerating}
										<SquareIcon fill="currentColor" />
										Stop enhancing
									{:else}
										<SparklesIcon />
										Enhance notes
									{/if}
								</DropdownMenu.Item>
								<DropdownMenu.Item onSelect={openModelSettingsFromMenu}>
									<SettingsIcon />
									AI model
								</DropdownMenu.Item>
								{#if templates.availableTemplates.length > 0}
									<DropdownMenu.Sub>
										<DropdownMenu.SubTrigger>
											<FileTextIcon />
											Template
										</DropdownMenu.SubTrigger>
										<DropdownMenu.SubContent class="max-h-72 overflow-y-auto">
											{#each templates.availableTemplates as template (template.id)}
												<DropdownMenu.CheckboxItem
													checked={template.id === templates.selectedTemplate}
													onSelect={() => void handleTemplateSelect(template.id, template.name)}
												>
													{template.name}
												</DropdownMenu.CheckboxItem>
											{/each}
										</DropdownMenu.SubContent>
									</DropdownMenu.Sub>
								{/if}
								<DropdownMenu.Sub>
									<DropdownMenu.SubTrigger>
										<LanguagesIcon />
										Language
									</DropdownMenu.SubTrigger>
									<DropdownMenu.SubContent class="max-h-72 overflow-y-auto">
										{#each [{ code: AUTO_SUMMARY_LANGUAGE, name: 'Automatic (English)' }, ...SUMMARY_LANGUAGES] as language (language.code)}
											<DropdownMenu.CheckboxItem
												checked={language.code === summaryLanguage.preferred}
												onSelect={() => summaryLanguage.set(language.code)}
											>
												{language.name}
											</DropdownMenu.CheckboxItem>
										{/each}
									</DropdownMenu.SubContent>
								</DropdownMenu.Sub>
								<DropdownMenu.Item
									disabled={!meetingData.aiSummary}
									onSelect={() => void copyOperations.handleCopySummary()}
								>
									<CopyIcon />
									Copy summary
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
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
					</div>
				</div>
			</div>
			<!-- Note header: large display title + date, Granola-style. -->
			<div class="flex-shrink-0 px-8 pb-1 pt-4">
				<div class="flex items-start">
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
						<h1 class="min-w-0 flex-1">
							<Tooltip.Provider>
								<Tooltip.Root disabled={!titleIsTruncated}>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="ghost"
												class="h-auto max-w-full cursor-text select-text justify-start truncate rounded-sm p-0 font-display text-3xl font-medium text-foreground hover:bg-transparent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
												onclick={() => void startEditTitle()}
											>
												<span use:observeTitleOverflow class="min-w-0 flex-1 truncate">
													{#if meetingData.meetingTitle?.trim()}
														{meetingData.meetingTitle}
													{:else}
														<span class="text-muted-foreground/50">Untitled meeting</span>
													{/if}
												</span>
											</Button>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content side="bottom" align="start" sideOffset={8}>
										{meetingData.meetingTitle}
									</Tooltip.Content>
								</Tooltip.Root>
							</Tooltip.Provider>
						</h1>
					{/if}
				</div>
				<div
					class="mt-1 flex min-h-10 flex-wrap items-center gap-x-1 text-sm text-muted-foreground"
				>
					{#if !isNaN(createdDate.getTime())}
						<span>
							{createdDate.toLocaleDateString(undefined, {
								weekday: 'long',
								month: 'long',
								day: 'numeric',
							})} · {createdDate.toLocaleTimeString(undefined, {
								hour: 'numeric',
								minute: '2-digit',
							})}
						</span>
					{/if}
					{#if attendeeChips.length > 0}
						<Tooltip.Provider>
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="sm"
											class="h-10 px-1.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
											aria-label={`${attendeeChips.length} ${attendeeChips.length === 1 ? 'participant' : 'participants'}`}
										>
											<UsersIcon data-icon="inline-start" />
											<span class="tabular-nums">{attendeeChips.length}</span>
											{attendeeChips.length === 1 ? 'participant' : 'participants'}
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content
									side="bottom"
									sideOffset={8}
									arrowClasses="hidden"
									class="block w-64 max-w-[calc(100vw-2rem)] p-1.5"
								>
									<p class="px-2 pb-1.5 pt-1 font-medium text-primary-foreground/70">
										Participants
									</p>
									<ul
										class="flex max-h-[min(16rem,calc(100vh-8rem))] flex-col gap-1 overflow-y-auto rounded-sm px-2 pb-1"
									>
										{#each attendeeChips as name (name)}
											<li class="break-words py-0.5 text-sm leading-5">{name}</li>
										{/each}
									</ul>
								</Tooltip.Content>
							</Tooltip.Root>
						</Tooltip.Provider>
					{/if}
					<div class="ml-auto flex items-center rounded-lg bg-secondary p-1" role="tablist">
						<Button
							variant={notesMode === 'enhanced' ? 'default' : 'ghost'}
							size="sm"
							class="h-7"
							role="tab"
							aria-selected={notesMode === 'enhanced'}
							onclick={() => (notesMode = 'enhanced')}
						>
							Enhanced notes
						</Button>
						<Button
							variant={notesMode === 'notes' ? 'default' : 'ghost'}
							size="sm"
							class="h-7"
							role="tab"
							aria-selected={notesMode === 'notes'}
							onclick={() => (notesMode = 'notes')}
						>
							Notes
						</Button>
					</div>
				</div>
			</div>

			<div class={cn('min-h-0 flex flex-1 overflow-hidden', notesMode !== 'enhanced' && 'hidden')}>
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

			<div
				class={cn(
					'min-h-0 flex-1 overflow-y-auto px-8 pb-32 pt-2',
					notesMode !== 'notes' && 'hidden',
				)}
			>
				<NotesView bind:this={notesView} {notesMarkdown} onSave={handleSaveNotes} />
			</div>
		</div>
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
