<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		ChevronDown,
		ChevronRight,
		Folder,
		FolderInput,
		FolderPlus,
		Home,
		PanelLeftClose,
		PanelLeftOpen,
		Pencil,
		Plus,
		Search,
		Settings,
		Trash2,
		Upload,
		X
	} from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';

	import { Analytics } from '$lib/analytics';
	import { cn } from '$lib/utils';
	import { toast } from '$lib/toast';
	import { config } from '$lib/stores/config.svelte';
	import { importDialog } from '$lib/stores/import-dialog.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { sidebar, type CurrentMeeting } from '$lib/stores/sidebar.svelte';
	import Dialog from '$lib/ui/dialog.svelte';
	import Button from '$lib/ui/button.svelte';
	import Input from '$lib/ui/input.svelte';
	import Tooltip from '$lib/ui/tooltip.svelte';

	let searchQuery = $state('');

	let deleteModal = $state<{ open: boolean; itemId: string | null }>({
		open: false,
		itemId: null
	});
	let editModal = $state<{ open: boolean; meetingId: string | null }>({
		open: false,
		meetingId: null
	});
	let editingTitle = $state('');

	const pathname = $derived(page.url.pathname);

	function findMatchingSnippet(itemId: string) {
		if (!searchQuery.trim() || !sidebar.searchResults.length) return null;
		return sidebar.searchResults.find((result) => result.id === itemId) ?? null;
	}

	// Search-filtered meetings. `api_search_transcripts` returns `m.id` (a meeting
	// id), so every search result id is also present in `sidebar.meetings` — the
	// intersection below cannot hide a hit.
	const filteredMeetings = $derived.by((): CurrentMeeting[] => {
		const items = sidebar.meetings;
		if (!searchQuery.trim()) return items;

		const query = searchQuery.toLowerCase();
		const matchedIds = new Set(sidebar.searchResults.map((r) => r.id));
		return items.filter((item) =>
			sidebar.searchResults.length > 0
				? matchedIds.has(item.id) || item.title.toLowerCase().includes(query)
				: item.title.toLowerCase().includes(query)
		);
	});

	// Granola-style relative date headings: Today, Yesterday, weekday, then dates.
	function dateGroupLabel(iso?: string): string {
		if (!iso) return 'Earlier';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return 'Earlier';
		const now = new Date();
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
		const diffDays = Math.round((startOfToday.getTime() - startOfDay.getTime()) / 86400000);
		if (diffDays <= 0) return 'Today';
		if (diffDays === 1) return 'Yesterday';
		if (d.getFullYear() === now.getFullYear())
			return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
		return d.toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	function timeLabel(iso?: string): string | null {
		if (!iso) return null;
		const d = new Date(iso);
		if (isNaN(d.getTime())) return null;
		return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	}

	interface NoteGroup {
		label: string;
		items: CurrentMeeting[];
	}

	interface FolderSection {
		id: string;
		name: string;
		meetings: CurrentMeeting[];
	}

	// Folder sections (above the date groups). When searching, hide folders with no
	// matching meetings; otherwise show every folder so users can move notes into them.
	const folderSections = $derived.by((): FolderSection[] =>
		sidebar.folders
			.map((f) => ({
				id: f.id,
				name: f.name,
				meetings: filteredMeetings.filter((m) => m.folderId === f.id)
			}))
			.filter((s) => (searchQuery.trim() ? s.meetings.length > 0 : true))
	);

	// Uncategorized meetings, date-grouped (Today / Yesterday / …).
	const uncategorizedGroups = $derived.by((): NoteGroup[] => {
		const groups: NoteGroup[] = [];
		for (const item of filteredMeetings.filter((m) => !m.folderId)) {
			const label = dateGroupLabel(item.createdAt);
			const last = groups[groups.length - 1];
			if (last && last.label === label) last.items.push(item);
			else groups.push({ label, items: [item] });
		}
		return groups;
	});

	const hasAnyNotes = $derived(filteredMeetings.length > 0 || sidebar.folders.length > 0);

	// Folder expand/collapse (folders start expanded; collapsed ids tracked here).
	const collapsedFolders = new SvelteSet<string>();
	function toggleFolder(id: string): void {
		if (collapsedFolders.has(id)) collapsedFolders.delete(id);
		else collapsedFolders.add(id);
	}

	// Folder + move-to-folder modals.
	let folderModal = $state<{ open: boolean; mode: 'create' | 'rename'; folderId: string | null }>({
		open: false,
		mode: 'create',
		folderId: null
	});
	let folderNameInput = $state('');
	let deleteFolderModal = $state<{ open: boolean; folderId: string | null; name: string }>({
		open: false,
		folderId: null,
		name: ''
	});
	let moveModal = $state<{ open: boolean; meetingId: string | null }>({
		open: false,
		meetingId: null
	});

	function openCreateFolder(): void {
		folderModal = { open: true, mode: 'create', folderId: null };
		folderNameInput = '';
	}
	function openRenameFolder(folderId: string, name: string): void {
		folderModal = { open: true, mode: 'rename', folderId };
		folderNameInput = name;
	}
	async function submitFolder(): Promise<void> {
		const name = folderNameInput.trim();
		if (!name) return;
		try {
			if (folderModal.mode === 'create') await sidebar.createFolder(name);
			else if (folderModal.folderId) await sidebar.renameFolder(folderModal.folderId, name);
			folderModal = { open: false, mode: 'create', folderId: null };
			folderNameInput = '';
		} catch (error) {
			toast.error('Failed to save folder', {
				description: error instanceof Error ? error.message : String(error)
			});
		}
	}
	async function confirmDeleteFolder(): Promise<void> {
		if (!deleteFolderModal.folderId) return;
		try {
			await sidebar.deleteFolder(deleteFolderModal.folderId);
		} catch (error) {
			toast.error('Failed to delete folder', {
				description: error instanceof Error ? error.message : String(error)
			});
		} finally {
			deleteFolderModal = { open: false, folderId: null, name: '' };
		}
	}
	async function moveTo(folderId: string | null): Promise<void> {
		const meetingId = moveModal.meetingId;
		moveModal = { open: false, meetingId: null };
		await applyMove(meetingId, folderId);
	}

	async function applyMove(meetingId: string | null, folderId: string | null): Promise<void> {
		if (!meetingId) return;
		try {
			await sidebar.moveMeetingToFolder(meetingId, folderId);
		} catch (error) {
			toast.error('Failed to move note', {
				description: error instanceof Error ? error.message : String(error)
			});
		}
	}

	// Drag-and-drop: drag a note row onto a folder (or the uncategorized area).
	// Pointer-based, not HTML5 DnD: inside the Tauri webview the native file-drop
	// handler swallows HTML5 `drop` events, and disabling it would break audio
	// import (which needs real OS paths). Pointer events bypass the OS drag layer
	// entirely, so meeting drags and file import coexist.
	let draggingMeetingId = $state<string | null>(null);
	// Highlight target: a folder id, or 'uncategorized', or null.
	let dragOverTarget = $state<string | null>(null);
	// Floating label that follows the cursor while dragging.
	let dragGhost = $state<{ title: string; x: number; y: number } | null>(null);
	// True once a pointer-down turns into a drag; lets the title button's click
	// handler ignore the click that fires when the pointer is released.
	let didDrag = false;
	const DRAG_THRESHOLD = 5;

	function handleRowPointerDown(e: PointerEvent, meeting: CurrentMeeting): void {
		if (e.button !== 0 || !isMeetingItem(meeting.id)) return;
		// Leave the hover controls (move/edit/delete) to their own click handlers.
		if ((e.target as HTMLElement).closest('[data-no-drag]')) return;

		const startX = e.clientX;
		const startY = e.clientY;
		didDrag = false;

		function onMove(ev: PointerEvent): void {
			if (!draggingMeetingId) {
				if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
				draggingMeetingId = meeting.id;
				didDrag = true;
				document.body.style.userSelect = 'none';
			}
			dragGhost = { title: meeting.title, x: ev.clientX, y: ev.clientY };
			const target = document
				.elementFromPoint(ev.clientX, ev.clientY)
				?.closest<HTMLElement>('[data-drop-target]');
			dragOverTarget = target?.dataset.dropTarget ?? null;
		}

		async function onUp(): Promise<void> {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			document.body.style.userSelect = '';
			const target = dragOverTarget;
			const dragged = draggingMeetingId;
			draggingMeetingId = null;
			dragOverTarget = null;
			dragGhost = null;
			if (dragged && target !== null) {
				await applyMove(dragged, target === 'uncategorized' ? null : target);
			}
		}

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}

	async function handleSearchChange(value: string): Promise<void> {
		searchQuery = value;
		await sidebar.searchTranscripts(value.trim() ? value : '');
	}

	function handleRecordingToggle(): void {
		const intent = sidebar.requestRecordingToggle(pathname);
		if (intent === 'navigate-home') {
			void goto('/');
		}
	}

	function selectMeeting(item: { id: string; title: string }): void {
		// Ignore the click that follows a drag (pointer-up synthesises a click).
		if (didDrag) {
			didDrag = false;
			return;
		}
		sidebar.setCurrentMeeting({ id: item.id, title: item.title });
		const basePath = isMeetingItem(item.id) ? `/meeting-details?id=${item.id}` : '/';
		void goto(basePath);
	}

	// Roving keyboard nav within a row: the title/toggle is the only Tab stop; the
	// inline action buttons are tabindex=-1 and reached with Arrow keys. ArrowRight/
	// ArrowLeft step through [title, ...actions] and Escape returns to the title.
	function handleRovingKeydown(e: KeyboardEvent): void {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Escape') return;
		const current = e.currentTarget as HTMLElement;
		const row = current.closest<HTMLElement>('[data-roving-row]');
		if (!row) return;
		const controls = Array.from(row.querySelectorAll<HTMLElement>('[data-roving]'));
		const idx = controls.indexOf(current);
		if (idx === -1) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			controls[0]?.focus();
			return;
		}
		const next = idx + (e.key === 'ArrowRight' ? 1 : -1);
		if (next < 0 || next >= controls.length) return;
		e.preventDefault();
		controls[next]?.focus();
	}

	async function handleDelete(itemId: string): Promise<void> {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('api_delete_meeting', { meetingId: itemId });

			sidebar.meetings = sidebar.meetings.filter((m: CurrentMeeting) => m.id !== itemId);
			void Analytics.trackMeetingDeleted(itemId);

			const { toast } = await import('$lib/toast');
			toast.success('Meeting moved to trash', {
				description: 'Restore it from Settings → Trash',
				action: {
					label: 'Undo',
					onClick: () => {
						void (async () => {
							try {
								await invoke('api_restore_meeting', { meetingId: itemId });
								await sidebar.refetchMeetings();
							} catch (error) {
								console.error('Failed to restore meeting:', error);
							}
						})();
					}
				}
			});

			if (sidebar.currentMeeting?.id === itemId) {
				sidebar.setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
				void goto('/');
			}
		} catch (error) {
			console.error('Failed to delete meeting:', error);
			const { toast } = await import('$lib/toast');
			toast.error('Failed to delete meeting', {
				description: error instanceof Error ? error.message : String(error)
			});
		}
	}

	function handleDeleteConfirm(): void {
		if (deleteModal.itemId) {
			void handleDelete(deleteModal.itemId);
		}
		deleteModal = { open: false, itemId: null };
	}

	function handleEditStart(meetingId: string, currentTitle: string): void {
		editModal = { open: true, meetingId };
		editingTitle = currentTitle;
	}

	async function handleEditConfirm(): Promise<void> {
		const newTitle = editingTitle.trim();
		const meetingId = editModal.meetingId;
		if (!meetingId) return;

		const { toast } = await import('$lib/toast');
		if (!newTitle) {
			toast.error('Meeting title cannot be empty');
			return;
		}

		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('api_save_meeting_title', { meetingId, title: newTitle });

			sidebar.meetings = sidebar.meetings.map((m: CurrentMeeting) =>
				m.id === meetingId ? { ...m, title: newTitle } : m
			);

			if (sidebar.currentMeeting?.id === meetingId) {
				sidebar.setCurrentMeeting({ id: meetingId, title: newTitle });
			}

			void Analytics.trackButtonClick('edit_meeting_title', 'sidebar');
			toast.success('Meeting title updated successfully');

			editModal = { open: false, meetingId: null };
			editingTitle = '';
		} catch (error) {
			console.error('Failed to update meeting title:', error);
			toast.error('Failed to update meeting title', {
				description: error instanceof Error ? error.message : String(error)
			});
		}
	}

	function handleEditCancel(): void {
		editModal = { open: false, meetingId: null };
		editingTitle = '';
	}

	// Expose openSettings to window for the Rust tray to call.
	onMount(() => {
		(window as unknown as { openSettings?: () => void }).openSettings = () => {
			void goto('/settings');
		};

		// Granola-style shortcuts: ⌘S toggles the sidebar, ⌘K focuses search.
		const handleKeydown = (e: KeyboardEvent): void => {
			if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
			const key = e.key.toLowerCase();
			if (key === 's') {
				e.preventDefault();
				sidebar.toggleCollapse();
			} else if (key === 'k') {
				e.preventDefault();
				if (sidebar.isCollapsed) sidebar.toggleCollapse();
				// Wait for the expanded layout to render before focusing.
				setTimeout(() => document.getElementById('sidebar-search')?.focus(), 50);
			}
		};
		window.addEventListener('keydown', handleKeydown);

		return () => {
			delete (window as unknown as { openSettings?: () => void }).openSettings;
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	function isMeetingItem(id: string): boolean {
		return id.includes('-') && !id.startsWith('intro-call');
	}

	function startResize(e: PointerEvent): void {
		e.preventDefault();
		sidebar.isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const onMove = (ev: PointerEvent): void => {
			// The sidebar is flush with the window's left edge.
			sidebar.setWidth(ev.clientX);
		};
		const onUp = (): void => {
			sidebar.isResizing = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			sidebar.persistWidth();
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}
</script>

<!-- The toggle lives outside the (zero-width when closed) sidebar so it stays
     anchored next to the traffic lights and only changes state. -->
<div class="fixed left-[4.55rem] top-[5px] z-50">
	<Tooltip label={sidebar.isCollapsed ? 'Open sidebar' : 'Close sidebar'} shortcut="⌘S">
		{#snippet trigger()}
			<button
				onclick={sidebar.toggleCollapse}
				class="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
				aria-label={sidebar.isCollapsed ? 'Open sidebar' : 'Close sidebar'}
			>
				{#if sidebar.isCollapsed}
					<PanelLeftOpen class="size-4" />
				{:else}
					<PanelLeftClose class="size-4" />
				{/if}
			</button>
		{/snippet}
	</Tooltip>
</div>

<div class="fixed left-0 top-0 z-40 h-screen">
	<div
		class={cn(
			'relative flex h-screen flex-col overflow-hidden border-r border-border bg-sidebar',
			!sidebar.isResizing && 'transition-[width] duration-300',
			sidebar.isCollapsed && 'border-r-0'
		)}
		style={`width: ${sidebar.effectiveWidth}px`}
	>
		{#if !sidebar.isCollapsed}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize sidebar"
				class={`absolute inset-y-0 -right-px z-50 w-1 cursor-col-resize transition-colors hover:bg-accent/40 ${
					sidebar.isResizing ? 'bg-accent/50' : ''
				}`}
				onpointerdown={startResize}
			></div>
		{/if}
		<!-- Overlay title bar: reserve space for the macOS traffic lights and
		     let the empty strip drag the window. -->
		<div data-tauri-drag-region="deep" class="h-8 flex-shrink-0"></div>
		{#if !sidebar.isCollapsed}
			<!-- Header -->
			<div class="flex-shrink-0 px-3 pb-1 pt-1">
				<div class="relative">
					<Search
						class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						id="sidebar-search"
						class="h-7 rounded-md border-transparent bg-foreground/[0.04] pl-8 pr-8 text-[13px] shadow-none placeholder:text-muted-foreground/70 focus:bg-background"
						placeholder="Search"
						value={searchQuery}
						oninput={(e) => handleSearchChange(e.currentTarget.value)}
					/>
					{#if !searchQuery}
						<span
							class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] tracking-wide text-muted-foreground/50"
						>
							⌘K
						</span>
					{/if}
					{#if searchQuery}
						<button
							onclick={() => handleSearchChange('')}
							class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							aria-label="Clear search"
						>
							<X class="size-3.5" />
						</button>
					{/if}
				</div>

				<button
					onclick={handleRecordingToggle}
					disabled={recordingState.isRecording}
					class={cn(
						'mt-2 flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
						recordingState.isRecording
							? 'cursor-not-allowed bg-destructive/10 text-destructive'
							: 'bg-accent text-accent-foreground hover:opacity-90'
					)}
				>
					{#if recordingState.isRecording}
						<span class="relative flex size-2">
							<span
								class="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"
							></span>
							<span class="relative inline-flex size-2 rounded-full bg-destructive"></span>
						</span>
						<span>Recording...</span>
					{:else}
						<Plus class="size-4" />
						<span>New note</span>
					{/if}
				</button>
			</div>

			<!-- Nav -->
			<div class="flex-shrink-0 px-3 pt-2">
				<button
					onclick={() => goto('/')}
					class={cn(
						'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
						pathname === '/'
							? 'bg-secondary font-medium text-foreground'
							: 'text-muted-foreground hover:bg-secondary hover:text-foreground'
					)}
				>
					<Home class="size-4" />
					<span>Home</span>
				</button>
			</div>

			<!-- Notes list -->
			<div class="custom-scrollbar mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
				{#if searchQuery && sidebar.isSearching}
					<div class="px-2 py-1 text-xs text-muted-foreground">Searching...</div>
				{/if}

				<!-- Meeting row, reused in folder sections and date groups. The title is a
				 real <button> (flex-1) for navigation; the hover controls are siblings,
				 so nothing interactive is nested in another control. The whole row is
				 draggable onto a folder. -->
				{#snippet meetingRow(child: CurrentMeeting)}
					{@const isActive = sidebar.currentMeeting?.id === child.id}
					{@const isMeeting = isMeetingItem(child.id)}
					{@const matchingResult = isMeeting ? findMatchingSnippet(child.id) : null}
					{@const time = timeLabel(child.createdAt)}
					<div
						class={cn(
							'group my-px flex flex-col rounded-md px-2 py-1 text-[13px] transition-colors duration-150',
							isActive
								? 'bg-secondary font-medium text-foreground'
								: 'text-foreground/80 hover:bg-secondary hover:text-foreground',
							draggingMeetingId === child.id && 'opacity-50'
						)}
						role="listitem"
						data-roving-row
						onpointerdown={(e) => handleRowPointerDown(e, child)}
					>
						<div class="flex h-5 w-full items-center gap-2">
							<button
								type="button"
								onclick={() => selectMeeting(child)}
								onkeydown={handleRovingKeydown}
								data-roving
								class="min-w-0 flex-1 truncate rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label={isMeeting ? `Open meeting: ${child.title}` : child.title}
							>
								{child.title}
							</button>
							{#if isMeeting}
								<div
									data-no-drag
									class="hidden flex-shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex"
								>
									<Tooltip label="Move to folder" closeOnEscape={false}>
										{#snippet trigger()}
											<button
												onclick={() => (moveModal = { open: true, meetingId: child.id })}
												onkeydown={handleRovingKeydown}
												data-roving
												tabindex={-1}
												class="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground"
												aria-label="Move to folder"
											>
												<FolderInput class="size-3.5" />
											</button>
										{/snippet}
									</Tooltip>
									<Tooltip label="Edit title" closeOnEscape={false}>
										{#snippet trigger()}
											<button
												onclick={() => handleEditStart(child.id, child.title)}
												onkeydown={handleRovingKeydown}
												data-roving
												tabindex={-1}
												class="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground"
												aria-label="Edit meeting title"
											>
												<Pencil class="size-3.5" />
											</button>
										{/snippet}
									</Tooltip>
									<Tooltip label="Delete meeting" closeOnEscape={false}>
										{#snippet trigger()}
											<button
												onclick={() => (deleteModal = { open: true, itemId: child.id })}
												onkeydown={handleRovingKeydown}
												data-roving
												tabindex={-1}
												class="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-destructive"
												aria-label="Delete meeting"
											>
												<Trash2 class="size-3.5" />
											</button>
										{/snippet}
									</Tooltip>
								</div>
							{/if}
							{#if time}
								<span
									class="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground/60 group-hover:hidden group-focus-within:hidden"
								>
									{time}
								</span>
							{/if}
						</div>

						{#if matchingResult}
							<button
								type="button"
								onclick={() => selectMeeting(child)}
								class="mt-1 line-clamp-2 text-left text-xs text-muted-foreground"
							>
								{matchingResult.matchContext}
							</button>
						{/if}
					</div>
				{/snippet}

				<!-- Folders header + create -->
				<div class="flex items-center justify-between px-2 pb-0.5 pt-2">
					<span class="text-[11px] font-medium text-muted-foreground/70">Folders</span>
					<Tooltip label="New folder">
						{#snippet trigger()}
							<button
								onclick={openCreateFolder}
								class="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
								aria-label="New folder"
							>
								<FolderPlus class="size-3.5" />
							</button>
						{/snippet}
					</Tooltip>
				</div>

				{#each folderSections as section (section.id)}
					{@const collapsed = collapsedFolders.has(section.id)}
					<!-- Whole section is a drop target; highlight while a note is dragged over. -->
					<div
						class={cn(
							'rounded-md transition-colors',
							dragOverTarget === section.id && 'bg-accent/10 ring-1 ring-accent/40'
						)}
						role="group"
						data-drop-target={section.id}
					>
						<div
							class="group/folder my-px flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-foreground/80 transition-colors hover:bg-secondary"
							data-roving-row
						>
							<button
								type="button"
								onclick={() => toggleFolder(section.id)}
								onkeydown={handleRovingKeydown}
								data-roving
								class="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label={collapsed ? `Expand ${section.name}` : `Collapse ${section.name}`}
								aria-expanded={!collapsed}
							>
								{#if collapsed}
									<ChevronRight class="size-3.5 flex-shrink-0 text-muted-foreground" />
								{:else}
									<ChevronDown class="size-3.5 flex-shrink-0 text-muted-foreground" />
								{/if}
								<Folder class="size-3.5 flex-shrink-0 text-muted-foreground" />
								<span class="min-w-0 flex-1 truncate font-medium">{section.name}</span>
							</button>
							<div
								class="hidden flex-shrink-0 items-center gap-0.5 group-hover/folder:flex group-focus-within/folder:flex"
							>
								<Tooltip label="Rename folder" closeOnEscape={false}>
									{#snippet trigger()}
										<button
											onclick={() => openRenameFolder(section.id, section.name)}
											onkeydown={handleRovingKeydown}
											data-roving
											tabindex={-1}
											class="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground"
											aria-label="Rename folder"
										>
											<Pencil class="size-3.5" />
										</button>
									{/snippet}
								</Tooltip>
								<Tooltip label="Delete folder" closeOnEscape={false}>
									{#snippet trigger()}
										<button
											onclick={() =>
												(deleteFolderModal = {
													open: true,
													folderId: section.id,
													name: section.name
												})}
											onkeydown={handleRovingKeydown}
											data-roving
											tabindex={-1}
											class="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-destructive"
											aria-label="Delete folder"
										>
											<Trash2 class="size-3.5" />
										</button>
									{/snippet}
								</Tooltip>
							</div>
							{#if !collapsed && section.meetings.length === 0}
								<span
									class="flex-shrink-0 text-[11px] text-muted-foreground/50 group-hover/folder:hidden group-focus-within/folder:hidden"
									>empty</span
								>
							{/if}
						</div>
						{#if !collapsed}
							<div class="ml-3 border-l border-border pl-1">
								{#each section.meetings as child (child.id)}
									{@render meetingRow(child)}
								{/each}
							</div>
						{/if}
					</div>
				{/each}

				<!-- Uncategorized notes; also a drop target to pull a note out of a folder. -->
				<div
					role="group"
					data-drop-target="uncategorized"
					class={cn(
						'rounded-md transition-colors',
						dragOverTarget === 'uncategorized' && 'bg-accent/10 ring-1 ring-accent/40'
					)}
				>
					{#each uncategorizedGroups as group (group.label)}
						<div class="px-2 pb-0.5 pt-3 text-[11px] font-medium text-muted-foreground/70">
							{group.label}
						</div>
						{#each group.items as child (child.id)}
							{@render meetingRow(child)}
						{/each}
					{/each}
				</div>

				{#if !hasAnyNotes && !sidebar.isSearching}
					<div class="px-2 py-3 text-sm text-muted-foreground">
						{searchQuery ? 'No notes found' : 'No notes yet'}
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex-shrink-0 border-t border-border px-3 py-2">
				<button
					onclick={() => importDialog.openImportDialog()}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
				>
					<Upload class="size-4" />
					<span>Import audio</span>
				</button>

				<button
					onclick={() => goto('/settings')}
					class={cn(
						'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
						pathname === '/settings'
							? 'bg-secondary font-medium text-foreground'
							: 'text-muted-foreground hover:bg-secondary hover:text-foreground'
					)}
				>
					<Settings class="size-4" />
					<span>Settings</span>
				</button>
			</div>
		{/if}
	</div>
</div>

<!-- Floating label that tracks the cursor while dragging a note onto a folder. -->
{#if dragGhost}
	<div
		class="pointer-events-none fixed z-50 max-w-48 truncate rounded-md bg-secondary px-2 py-1 text-[13px] font-medium text-foreground shadow-md ring-1 ring-border"
		style="left: {dragGhost.x + 12}px; top: {dragGhost.y + 12}px;"
	>
		{dragGhost.title}
	</div>
{/if}

<!-- Delete confirmation -->
<Dialog
	open={deleteModal.open}
	onOpenChange={(next) => {
		if (!next) deleteModal = { open: false, itemId: null };
	}}
	title="Delete meeting"
	hideTitle
>
	<p class="text-sm">
		Move this meeting to the trash? You can restore it from Settings → Trash.
	</p>
	{#snippet footer()}
		<Button variant="outline" onclick={() => (deleteModal = { open: false, itemId: null })}>
			Cancel
		</Button>
		<Button variant="destructive" onclick={handleDeleteConfirm}>Delete</Button>
	{/snippet}
</Dialog>

<!-- Edit meeting title -->
<Dialog
	open={editModal.open}
	onOpenChange={(next) => {
		if (!next) handleEditCancel();
	}}
	title="Edit Meeting Title"
	hideTitle
	class="sm:max-w-[425px]"
>
	<div class="py-4">
		<h3 class="mb-4 text-lg font-semibold">Edit Meeting Title</h3>
		<div class="space-y-4">
			<div>
				<label for="meeting-title" class="mb-2 block text-sm font-medium text-foreground">
					Meeting Title
				</label>
				<Input
					id="meeting-title"
					value={editingTitle}
					oninput={(e) => (editingTitle = e.currentTarget.value)}
					onkeydown={(e) => {
						if (e.key === 'Enter') void handleEditConfirm();
						else if (e.key === 'Escape') handleEditCancel();
					}}
					placeholder="Enter meeting title"
				/>
			</div>
		</div>
	</div>
	{#snippet footer()}
		<Button variant="outline" onclick={handleEditCancel}>Cancel</Button>
		<Button onclick={handleEditConfirm}>Save</Button>
	{/snippet}
</Dialog>

<!-- Create / rename folder -->
<Dialog
	open={folderModal.open}
	onOpenChange={(next) => {
		if (!next) folderModal = { open: false, mode: 'create', folderId: null };
	}}
	title={folderModal.mode === 'create' ? 'New folder' : 'Rename folder'}
	hideTitle
	class="sm:max-w-[425px]"
>
	<div class="py-4">
		<h3 class="mb-4 text-lg font-semibold">
			{folderModal.mode === 'create' ? 'New folder' : 'Rename folder'}
		</h3>
		<Input
			value={folderNameInput}
			oninput={(e) => (folderNameInput = e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === 'Enter') void submitFolder();
			}}
			placeholder="Folder name"
		/>
	</div>
	{#snippet footer()}
		<Button
			variant="outline"
			onclick={() => (folderModal = { open: false, mode: 'create', folderId: null })}
		>
			Cancel
		</Button>
		<Button onclick={submitFolder}>
			{folderModal.mode === 'create' ? 'Create' : 'Save'}
		</Button>
	{/snippet}
</Dialog>

<!-- Delete folder confirmation -->
<Dialog
	open={deleteFolderModal.open}
	onOpenChange={(next) => {
		if (!next) deleteFolderModal = { open: false, folderId: null, name: '' };
	}}
	title="Delete folder"
	hideTitle
>
	<p class="text-sm">
		Delete the folder <strong>{deleteFolderModal.name}</strong>? Notes inside it are kept and moved
		back to the date list.
	</p>
	{#snippet footer()}
		<Button
			variant="outline"
			onclick={() => (deleteFolderModal = { open: false, folderId: null, name: '' })}
		>
			Cancel
		</Button>
		<Button variant="destructive" onclick={confirmDeleteFolder}>Delete folder</Button>
	{/snippet}
</Dialog>

<!-- Move meeting to folder -->
<Dialog
	open={moveModal.open}
	onOpenChange={(next) => {
		if (!next) moveModal = { open: false, meetingId: null };
	}}
	title="Move to folder"
	hideTitle
	class="sm:max-w-[425px]"
>
	<div class="py-4">
		<h3 class="mb-4 text-lg font-semibold">Move to folder</h3>
		<div class="space-y-1">
			{#each sidebar.folders as folder (folder.id)}
				<button
					onclick={() => moveTo(folder.id)}
					class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-secondary"
				>
					<Folder class="size-4 text-muted-foreground" />
					<span class="truncate">{folder.name}</span>
				</button>
			{/each}
			<button
				onclick={() => moveTo(null)}
				class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary"
			>
				<X class="size-4" />
				<span>No folder (uncategorized)</span>
			</button>
			{#if sidebar.folders.length === 0}
				<p class="px-3 py-2 text-sm text-muted-foreground">
					No folders yet. Create one with the + next to “Folders”.
				</p>
			{/if}
		</div>
	</div>
</Dialog>
