<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
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

	import { Analytics } from '$lib/analytics';
	import { cn } from '$lib/utils';
	import { compareByDateDesc, groupByRecency, RECENT_GROUP_LABEL } from '$lib/date-groups';
	import { clock } from '$lib/now.svelte';
	import { toast } from '$lib/toast';
	import { config } from '$lib/stores/config.svelte';
	import { importDialog } from '$lib/stores/import-dialog.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { sidebar, type CurrentMeeting } from '$lib/stores/sidebar.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tooltip from '$lib/components/ui/tooltip';

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

	// O(1) folder-name lookup for the search-result folder chips — rebuilt only
	// when folders change, instead of scanning sidebar.folders per rendered row.
	const folderNames = $derived(new Map(sidebar.folders.map((f) => [f.id, f.name])));

	// Flat, recency-sorted results while searching — spans folders and uncategorized
	// notes so a note tucked inside a folder is still reachable from the search box.
	const searchResults = $derived(
		searchQuery.trim()
			? [...filteredMeetings].sort((a, b) => compareByDateDesc(a.createdAt, b.createdAt))
			: []
	);

	// Uncategorized notes, bucketed by recency. The current week is one free-flowing
	// list (rendered without a header); older notes fall into wider, headed buckets.
	const uncategorizedGroups = $derived(
		groupByRecency(
			filteredMeetings.filter((m) => !m.folderId),
			(m) => m.createdAt,
			clock.now
		)
	);

	const hasAnyNotes = $derived(filteredMeetings.length > 0 || sidebar.folders.length > 0);

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
     anchored next to the traffic lights and only changes state. It sits in a
     top-anchored h-9 row and is vertically centered, matching the page back
     buttons (also an icon-sm centered in an h-9 header) so the two align. -->
<div class="fixed left-[4.55rem] top-0 z-50 flex h-9 items-center">
	<Tooltip.Provider delayDuration={300}>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						onclick={sidebar.toggleCollapse}
						class="text-muted-foreground/70"
						aria-label={sidebar.isCollapsed ? 'Open sidebar' : 'Close sidebar'}
					>
						{#if sidebar.isCollapsed}
							<PanelLeftOpen />
						{:else}
							<PanelLeftClose />
						{/if}
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				<span class="flex items-center">
					{sidebar.isCollapsed ? 'Open sidebar' : 'Close sidebar'}
					<span class="ml-1.5 tracking-wide opacity-60">⌘S</span>
				</span>
			</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
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
				class={cn(
					'absolute inset-y-0 -right-px z-50 w-1 cursor-col-resize transition-colors hover:bg-accent/40',
					sidebar.isResizing && 'bg-accent/50'
				)}
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
						class="h-7 border-transparent bg-foreground/[0.04] pl-8 pr-8 shadow-none focus:bg-background"
						placeholder="Search"
						aria-label="Search notes"
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
						<Button
							variant="ghost"
							size="icon-xs"
							onclick={() => handleSearchChange('')}
							class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
							aria-label="Clear search"
						>
							<X />
						</Button>
					{/if}
				</div>

				{#if recordingState.isRecording}
					<Button disabled variant="destructive" size="sm" class="mt-2 w-full cursor-not-allowed">
						<span class="relative flex size-2">
							<span
								class="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"
							></span>
							<span class="relative inline-flex size-2 rounded-full bg-destructive"></span>
						</span>
						<span>Recording...</span>
					</Button>
				{:else}
					<Button variant="accent" size="sm" onclick={handleRecordingToggle} class="mt-2 h-7 w-full">
						<Plus />
						<span>New note</span>
					</Button>
				{/if}
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
				{#snippet meetingRow(meeting: CurrentMeeting)}
					{@const isActive = sidebar.currentMeeting?.id === meeting.id}
					{@const isMeeting = isMeetingItem(meeting.id)}
					{@const matchingResult = isMeeting ? findMatchingSnippet(meeting.id) : null}
					{@const folderName = meeting.folderId ? (folderNames.get(meeting.folderId) ?? null) : null}
					<div
						class={cn(
							'group my-px flex flex-col rounded-md px-2 py-1 text-[13px] transition-colors duration-150',
							isActive
								? 'bg-secondary font-medium text-foreground'
								: 'text-foreground/80 hover:bg-secondary hover:text-foreground',
							draggingMeetingId === meeting.id && 'opacity-50'
						)}
						role="listitem"
						data-roving-row
						onpointerdown={(e) => handleRowPointerDown(e, meeting)}
					>
						<div class="flex h-5 w-full items-center gap-2">
							<button
								type="button"
								onclick={() => selectMeeting(meeting)}
								onkeydown={handleRovingKeydown}
								data-roving
								class="min-w-0 flex-1 truncate rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label={isMeeting ? `Open meeting: ${meeting.title}` : meeting.title}
							>
								{meeting.title}
							</button>
							{#if folderName}
								<span
									class="flex min-w-0 max-w-[45%] flex-shrink-0 items-center gap-1 text-xs text-muted-foreground/60 group-hover:hidden group-focus-within:hidden"
								>
									<Folder class="size-3 shrink-0" />
									<span class="truncate">{folderName}</span>
								</span>
							{/if}
							{#if isMeeting}
								<div
									data-no-drag
									class="hidden flex-shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex"
								>
									<Tooltip.Provider delayDuration={300}>
										<Tooltip.Root>
											<Tooltip.Trigger>
												{#snippet child({ props })}
													<Button
														{...props}
														variant="ghost"
														size="icon-xs"
														onclick={() => (moveModal = { open: true, meetingId: meeting.id })}
														onkeydown={handleRovingKeydown}
														data-roving
														tabindex={-1}
														class="text-muted-foreground hover:bg-border"
														aria-label="Move to folder"
													>
														<FolderInput />
													</Button>
												{/snippet}
											</Tooltip.Trigger>
											<Tooltip.Content>Move to folder</Tooltip.Content>
										</Tooltip.Root>
									</Tooltip.Provider>
									<Tooltip.Provider delayDuration={300}>
										<Tooltip.Root>
											<Tooltip.Trigger>
												{#snippet child({ props })}
													<Button
														{...props}
														variant="ghost"
														size="icon-xs"
														onclick={() => handleEditStart(meeting.id, meeting.title)}
														onkeydown={handleRovingKeydown}
														data-roving
														tabindex={-1}
														class="text-muted-foreground hover:bg-border"
														aria-label="Edit meeting title"
													>
														<Pencil />
													</Button>
												{/snippet}
											</Tooltip.Trigger>
											<Tooltip.Content>Edit title</Tooltip.Content>
										</Tooltip.Root>
									</Tooltip.Provider>
									<Tooltip.Provider delayDuration={300}>
										<Tooltip.Root>
											<Tooltip.Trigger>
												{#snippet child({ props })}
													<Button
														{...props}
														variant="ghost"
														size="icon-xs"
														onclick={() => (deleteModal = { open: true, itemId: meeting.id })}
														onkeydown={handleRovingKeydown}
														data-roving
														tabindex={-1}
														class="text-muted-foreground hover:bg-border hover:text-destructive"
														aria-label="Delete meeting"
													>
														<Trash2 />
													</Button>
												{/snippet}
											</Tooltip.Trigger>
											<Tooltip.Content>Delete meeting</Tooltip.Content>
										</Tooltip.Root>
									</Tooltip.Provider>
								</div>
							{/if}
						</div>

						{#if matchingResult}
							<button
								type="button"
								onclick={() => selectMeeting(meeting)}
								class="mt-1 line-clamp-2 text-left text-xs text-muted-foreground"
							>
								{matchingResult.matchContext}
							</button>
						{/if}
					</div>
				{/snippet}

				<!-- Folders header + create -->
				<div
					class={cn(
						'flex items-center justify-between px-2 pb-0.5 pt-2',
						searchQuery.trim() && 'hidden'
					)}
				>
					<span class="text-xs font-medium text-muted-foreground/70">Folders</span>
					<Tooltip.Provider delayDuration={300}>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-xs"
										onclick={openCreateFolder}
										class="text-muted-foreground"
										aria-label="New folder"
									>
										<FolderPlus />
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>New folder</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
				</div>

				{#each searchQuery.trim() ? [] : sidebar.folders as section (section.id)}
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
							class="group/folder relative my-px flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-foreground/80 transition-colors hover:bg-secondary"
							data-roving-row
						>
							<button
								type="button"
								onclick={() => goto(`/folder?id=${section.id}`)}
								onkeydown={handleRovingKeydown}
								data-roving
								class="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label={`Open folder ${section.name}`}
							>
								<Folder class="size-3.5 flex-shrink-0 text-muted-foreground" />
								<span class="min-w-0 flex-1 truncate font-medium">{section.name}</span>
							</button>
							<div
								class="absolute inset-y-0 right-1 hidden items-center gap-0.5 rounded-md bg-secondary pl-2 group-hover/folder:flex group-focus-within/folder:flex"
							>
								<Tooltip.Provider delayDuration={300}>
									<Tooltip.Root>
										<Tooltip.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													variant="ghost"
													size="icon-xs"
													onclick={() => openRenameFolder(section.id, section.name)}
													onkeydown={handleRovingKeydown}
													data-roving
													tabindex={-1}
													class="text-muted-foreground hover:bg-border"
													aria-label="Rename folder"
												>
													<Pencil />
												</Button>
											{/snippet}
										</Tooltip.Trigger>
										<Tooltip.Content>Rename folder</Tooltip.Content>
									</Tooltip.Root>
								</Tooltip.Provider>
								<Tooltip.Provider delayDuration={300}>
									<Tooltip.Root>
										<Tooltip.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													variant="ghost"
													size="icon-xs"
													onclick={() =>
														(deleteFolderModal = {
															open: true,
															folderId: section.id,
															name: section.name
														})}
													onkeydown={handleRovingKeydown}
													data-roving
													tabindex={-1}
													class="text-muted-foreground hover:bg-border hover:text-destructive"
													aria-label="Delete folder"
												>
													<Trash2 />
												</Button>
											{/snippet}
										</Tooltip.Trigger>
										<Tooltip.Content>Delete folder</Tooltip.Content>
									</Tooltip.Root>
								</Tooltip.Provider>
							</div>
						</div>
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
					{#if searchQuery.trim()}
						{#if searchResults.length === 0 && !sidebar.isSearching}
							<div class="px-2 py-3 text-sm text-muted-foreground">No notes found</div>
						{:else}
							{#each searchResults as child (child.id)}
								{@render meetingRow(child)}
							{/each}
						{/if}
					{:else}
						{#each uncategorizedGroups as group (group.label)}
							{#if group.label !== RECENT_GROUP_LABEL}
								<div class="px-2 pb-0.5 pt-3 text-xs font-medium text-muted-foreground/70">
									{group.label}
								</div>
							{/if}
							{#each group.items as child (child.id)}
								{@render meetingRow(child)}
							{/each}
						{/each}
					{/if}
				</div>

				{#if !hasAnyNotes && !searchQuery.trim()}
					<div class="px-2 py-3 text-sm text-muted-foreground">No notes yet</div>
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
<Dialog.Root
	open={deleteModal.open}
	onOpenChange={(next) => {
		if (!next) deleteModal = { open: false, itemId: null };
	}}
>
	<Dialog.Content>
		<Dialog.Title class="sr-only">Delete meeting</Dialog.Title>
		<p class="text-sm">
			Move this meeting to the trash? You can restore it from Settings → Trash.
		</p>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteModal = { open: false, itemId: null })}>
				Cancel
			</Button>
			<Button variant="destructive" onclick={handleDeleteConfirm}>Delete</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Edit meeting title -->
<Dialog.Root
	open={editModal.open}
	onOpenChange={(next) => {
		if (!next) handleEditCancel();
	}}
>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Title class="text-lg font-semibold">Edit Meeting Title</Dialog.Title>
		<div class="flex flex-col gap-2">
			<label for="meeting-title" class="text-sm font-medium text-foreground">Meeting Title</label>
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
		<Dialog.Footer>
			<Button variant="outline" onclick={handleEditCancel}>Cancel</Button>
			<Button onclick={handleEditConfirm}>Save</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Create / rename folder -->
<Dialog.Root
	open={folderModal.open}
	onOpenChange={(next) => {
		if (!next) folderModal = { open: false, mode: 'create', folderId: null };
	}}
>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Title class="text-lg font-semibold">
			{folderModal.mode === 'create' ? 'New folder' : 'Rename folder'}
		</Dialog.Title>
		<Input
			value={folderNameInput}
			oninput={(e) => (folderNameInput = e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === 'Enter') void submitFolder();
			}}
			placeholder="Folder name"
		/>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => (folderModal = { open: false, mode: 'create', folderId: null })}
			>
				Cancel
			</Button>
			<Button onclick={submitFolder}>
				{folderModal.mode === 'create' ? 'Create' : 'Save'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Delete folder confirmation -->
<Dialog.Root
	open={deleteFolderModal.open}
	onOpenChange={(next) => {
		if (!next) deleteFolderModal = { open: false, folderId: null, name: '' };
	}}
>
	<Dialog.Content>
		<Dialog.Title class="sr-only">Delete folder</Dialog.Title>
		<p class="text-sm">
			Delete the folder <strong>{deleteFolderModal.name}</strong>? Notes inside it are kept and moved
			back to the date list.
		</p>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => (deleteFolderModal = { open: false, folderId: null, name: '' })}
			>
				Cancel
			</Button>
			<Button variant="destructive" onclick={confirmDeleteFolder}>Delete folder</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Move meeting to folder -->
<Dialog.Root
	open={moveModal.open}
	onOpenChange={(next) => {
		if (!next) moveModal = { open: false, meetingId: null };
	}}
>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Title class="text-lg font-semibold">Move to folder</Dialog.Title>
		<div class="flex flex-col gap-1">
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
	</Dialog.Content>
</Dialog.Root>
