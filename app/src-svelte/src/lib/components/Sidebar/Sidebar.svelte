<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { navigate } from '$lib/navigation';
	import {
		Ellipsis,
		Folder,
		FolderPlus,
		Home,
		PanelLeftClose,
		PanelLeftOpen,
		Pencil,
		Plus,
		Search,
		Settings,
		Star,
		StarOff,
		Trash2,
		Upload,
		Users,
	} from '@lucide/svelte';

	import { Analytics } from '$lib/analytics';
	import { cn } from '$lib/utils';
	import { toast } from '$lib/toast';
	import { config } from '$lib/stores/config.svelte';
	import { importDialog } from '$lib/stores/import-dialog.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import {
		sidebar,
		type CurrentMeeting,
		type Folder as FolderInfo,
	} from '$lib/stores/sidebar.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import BackgroundTasksButton from './BackgroundTasksButton.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import { SETTINGS_TABS, SETTINGS_TRASH, resolveSettingsTab } from '$lib/settings-tabs';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let deleteModal = $state<{ open: boolean; itemId: string | null }>({
		open: false,
		itemId: null,
	});
	let editModal = $state<{ open: boolean; meetingId: string | null }>({
		open: false,
		meetingId: null,
	});
	let editingTitle = $state('');

	const pathname = $derived(page.url.pathname);

	// While in Settings, the sidebar shows the settings sections instead of folders
	// (Trash pinned to the bottom). Navigation is URL-driven (/settings?tab=…).
	const platform = usePlatform();
	const isSettings = $derived(pathname.startsWith('/settings'));
	const settingsTabs = $derived(SETTINGS_TABS.filter((t) => !t.macOnly || platform.isMac));
	const activeSettingsTab = $derived(resolveSettingsTab(page.url.searchParams.get('tab')));

	// Folder + move-to-folder modals.
	let folderModal = $state<{
		open: boolean;
		mode: 'create' | 'rename';
		folderId: string | null;
		parentId: string | null;
	}>({
		open: false,
		mode: 'create',
		folderId: null,
		parentId: null,
	});
	let folderNameInput = $state('');
	let folderEmojiInput = $state('');
	let deleteFolderModal = $state<{ open: boolean; folderId: string | null; name: string }>({
		open: false,
		folderId: null,
		name: '',
	});

	// Sidebar folder organization: favorites pinned above the tree, subfolders
	// (one level) indented under their parent.
	const favoriteFolders = $derived(sidebar.folders.filter((f) => f.favorited));
	const rootFolders = $derived(sidebar.folders.filter((f) => !f.parentId));
	const subfoldersOf = $derived.by(() => {
		const map = new Map<string, FolderInfo[]>();
		for (const f of sidebar.folders) {
			if (!f.parentId) continue;
			const list = map.get(f.parentId) ?? [];
			list.push(f);
			map.set(f.parentId, list);
		}
		return map;
	});
	// Keeps a row's hover-revealed trigger visible while its menu is open.
	let openFolderMenuId = $state<string | null>(null);

	function openCreateFolder(parentId: string | null = null): void {
		folderModal = { open: true, mode: 'create', folderId: null, parentId };
		folderNameInput = '';
		folderEmojiInput = '';
	}
	function openRenameFolder(folderId: string, name: string, emoji: string | null): void {
		folderModal = { open: true, mode: 'rename', folderId, parentId: null };
		folderNameInput = name;
		folderEmojiInput = emoji ?? '';
	}
	async function submitFolder(): Promise<void> {
		const name = folderNameInput.trim();
		if (!name) return;
		const emoji = folderEmojiInput.trim() || null;
		try {
			if (folderModal.mode === 'create')
				await sidebar.createFolder(name, emoji, folderModal.parentId);
			else if (folderModal.folderId) await sidebar.updateFolder(folderModal.folderId, name, emoji);
			folderModal = { open: false, mode: 'create', folderId: null, parentId: null };
			folderNameInput = '';
			folderEmojiInput = '';
		} catch (error) {
			toast.error('Failed to save folder', {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}
	async function toggleFolderFavorite(folder: FolderInfo): Promise<void> {
		try {
			await sidebar.setFolderFavorite(folder.id, !folder.favorited);
		} catch (error) {
			toast.error('Failed to update favorites', {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}
	async function confirmDeleteFolder(): Promise<void> {
		if (!deleteFolderModal.folderId) return;
		try {
			await sidebar.deleteFolder(deleteFolderModal.folderId);
		} catch (error) {
			toast.error('Failed to delete folder', {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			deleteFolderModal = { open: false, folderId: null, name: '' };
		}
	}

	// Search lives in the main-area /search view; this just opens it, pre-scoped to
	// the current folder when one is being viewed.
	function openSearch(): void {
		const folderId = page.url.pathname === '/folder' ? page.url.searchParams.get('id') : null;
		void navigate(folderId ? `/search?folder=${folderId}` : '/search');
	}

	function handleRecordingToggle(): void {
		const intent = sidebar.requestRecordingToggle(pathname);
		if (intent === 'navigate-editor') {
			void goto('/note');
		}
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
					},
				},
			});

			if (sidebar.currentMeeting?.id === itemId) {
				sidebar.setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
				void navigate('/');
			}
		} catch (error) {
			console.error('Failed to delete meeting:', error);
			const { toast } = await import('$lib/toast');
			toast.error('Failed to delete meeting', {
				description: error instanceof Error ? error.message : String(error),
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
				m.id === meetingId ? { ...m, title: newTitle } : m,
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
				description: error instanceof Error ? error.message : String(error),
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
			void navigate('/settings');
		};

		// Granola-style shortcuts: ⌘S toggles the sidebar, ⌘K opens search.
		const handleKeydown = (e: KeyboardEvent): void => {
			if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
			const key = e.key.toLowerCase();
			if (key === 's') {
				e.preventDefault();
				sidebar.toggleCollapse();
			} else if (key === 'k') {
				e.preventDefault();
				openSearch();
			}
		};
		window.addEventListener('keydown', handleKeydown);

		return () => {
			delete (window as unknown as { openSettings?: () => void }).openSettings;
			window.removeEventListener('keydown', handleKeydown);
		};
	});
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
	<Tooltip.Provider delayDuration={300}>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						onclick={openSearch}
						class="text-muted-foreground/70"
						aria-label="Search notes"
					>
						<Search />
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				<span class="flex items-center">
					Search
					<span class="ml-1.5 tracking-wide opacity-60">⌘K</span>
				</span>
			</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
	<BackgroundTasksButton />
</div>

<div class="fixed left-0 top-0 z-40 h-screen">
	<div
		class={cn(
			'relative flex h-screen flex-col overflow-hidden border-r border-border bg-sidebar',
			'transition-[width] duration-300',
			sidebar.isCollapsed && 'border-r-0',
		)}
		style={`width: ${sidebar.effectiveWidth}px`}
	>
		<!-- Overlay title bar: reserve space for the macOS traffic lights and
		     let the empty strip drag the window. -->
		<div data-tauri-drag-region="deep" class="h-8 shrink-0"></div>
		{#if !sidebar.isCollapsed}
			<!-- Header -->
			<div class="shrink-0 px-3 pb-1 pt-1">
				{#if recordingState.isRecording}
					<Button disabled variant="destructive" size="sm" class="w-full cursor-not-allowed">
						<span class="relative flex size-2">
							<span
								class="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"
							></span>
							<span class="relative inline-flex size-2 rounded-full bg-destructive"></span>
						</span>
						<span>Recording...</span>
					</Button>
				{:else}
					<Button variant="brand" size="sm" onclick={handleRecordingToggle} class="h-7 w-full">
						<Plus />
						<span>New note</span>
					</Button>
				{/if}
			</div>

			<!-- Nav -->
			<div class="flex-shrink-0 px-3 pt-2">
				<button
					onclick={() => navigate('/')}
					class={cn(
						'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
						pathname === '/'
							? 'bg-secondary font-medium text-foreground'
							: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
					)}
				>
					<Home class="size-4" />
					<span>Home</span>
				</button>
			</div>

			<!-- Notes list -->
			<div class="custom-scrollbar mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
				{#if isSettings}
					<!-- Settings sections (replaces folders while in Settings) -->
					<div class="px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground/70">Settings</div>
					{#each settingsTabs as tab (tab.value)}
						{@const Icon = tab.icon}
						<button
							type="button"
							onclick={() => navigate(`/settings?tab=${tab.value}`)}
							class={cn(
								'my-px flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors',
								activeSettingsTab === tab.value
									? 'bg-secondary font-medium text-foreground'
									: 'text-foreground/80 hover:bg-secondary hover:text-foreground',
							)}
						>
							<Icon class="size-4 text-muted-foreground" />
							{tab.label}
						</button>
					{/each}
				{:else}
					{#snippet folderRow(section: FolderInfo, depth: number, rowKey: string)}
						<div class="rounded-md">
							<div
								class={cn(
									'group/folder relative my-px flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-foreground/80 transition-colors hover:bg-secondary',
									depth > 0 && 'ml-4',
								)}
								data-roving-row
							>
								<button
									type="button"
									onclick={() => navigate(`/folder?id=${section.id}`)}
									onkeydown={handleRovingKeydown}
									data-roving
									class="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label={`Open folder ${section.name}`}
								>
									{#if section.emoji}
										<span class="flex-shrink-0 text-[13px] leading-none">{section.emoji}</span>
									{:else}
										<Folder class="size-3.5 flex-shrink-0 text-muted-foreground" />
									{/if}
									<span class="min-w-0 flex-1 truncate font-medium">{section.name}</span>
								</button>
								<div
									class={cn(
										'absolute inset-y-0 right-1 hidden items-center rounded-md pl-2 group-hover/folder:flex group-focus-within/folder:flex',
										openFolderMenuId === rowKey && 'flex',
									)}
								>
									<DropdownMenu.Root
										open={openFolderMenuId === rowKey}
										onOpenChange={(open) => (openFolderMenuId = open ? rowKey : null)}
									>
										<DropdownMenu.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													variant="ghost"
													size="icon-xs"
													onkeydown={handleRovingKeydown}
													data-roving
													tabindex={-1}
													class="text-muted-foreground hover:bg-border"
													aria-label={`Folder actions for ${section.name}`}
												>
													<Ellipsis />
												</Button>
											{/snippet}
										</DropdownMenu.Trigger>
										<DropdownMenu.Content align="start" class="min-w-44">
											{#if !section.parentId}
												<DropdownMenu.Item onSelect={() => openCreateFolder(section.id)}>
													<FolderPlus />
													Create subfolder
												</DropdownMenu.Item>
											{/if}
											<DropdownMenu.Item onSelect={() => void toggleFolderFavorite(section)}>
												{#if section.favorited}
													<StarOff />
													Remove from favorites
												{:else}
													<Star />
													Add to favorites
												{/if}
											</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item
												onSelect={() =>
													openRenameFolder(section.id, section.name, section.emoji ?? null)}
											>
												<Pencil />
												Rename
											</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item
												variant="destructive"
												onSelect={() =>
													(deleteFolderModal = {
														open: true,
														folderId: section.id,
														name: section.name,
													})}
											>
												<Trash2 />
												Delete folder
											</DropdownMenu.Item>
										</DropdownMenu.Content>
									</DropdownMenu.Root>
								</div>
							</div>
						</div>
					{/snippet}

					{#if favoriteFolders.length > 0}
						<div class="px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground/70">
							Favorites
						</div>
						{#each favoriteFolders as section (section.id)}
							{@render folderRow(section, 0, `fav-${section.id}`)}
						{/each}
					{/if}

					<!-- Folders header + create -->
					<div class="flex items-center justify-between px-2 pb-0.5 pt-2">
						<span class="text-xs font-medium text-muted-foreground/70">Folders</span>
						<Tooltip.Provider delayDuration={300}>
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-xs"
											onclick={() => openCreateFolder()}
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

					{#each rootFolders as section (section.id)}
						{@render folderRow(section, 0, `tree-${section.id}`)}
						{#each subfoldersOf.get(section.id) ?? [] as child (child.id)}
							{@render folderRow(child, 1, `tree-${child.id}`)}
						{/each}
					{/each}
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex-shrink-0 border-t border-border px-3 py-2">
				{#if isSettings}
					<!-- Trash pinned to the bottom of the settings nav. -->
					<button
						type="button"
						onclick={() => navigate(`/settings?tab=${SETTINGS_TRASH.value}`)}
						class={cn(
							'mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
							activeSettingsTab === SETTINGS_TRASH.value
								? 'bg-destructive/10 font-medium text-destructive'
								: 'text-destructive/70 hover:bg-destructive/10 hover:text-destructive',
						)}
					>
						<Trash2 class="size-4" />
						<span>{SETTINGS_TRASH.label}</span>
					</button>
				{:else}
					<button
						onclick={() => importDialog.openImportDialog()}
						class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
					>
						<Upload class="size-4" />
						<span>Import audio</span>
					</button>

					<button
						type="button"
						onclick={() => navigate('/people')}
						class={cn(
							'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
							pathname === '/people'
								? 'bg-secondary font-medium text-foreground'
								: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
						)}
					>
						<Users class="size-4" />
						<span>People</span>
					</button>

					<button
						onclick={() => navigate('/settings')}
						class={cn(
							'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
							pathname === '/settings'
								? 'bg-secondary font-medium text-foreground'
								: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
						)}
					>
						<Settings class="size-4" />
						<span>Settings</span>
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<!-- Delete confirmation -->
<Dialog.Root
	open={deleteModal.open}
	onOpenChange={(next) => {
		if (!next) deleteModal = { open: false, itemId: null };
	}}
>
	<Dialog.Content>
		<Dialog.Title class="sr-only">Delete meeting</Dialog.Title>
		<p class="text-sm">Move this meeting to the trash? You can restore it from Settings → Trash.</p>
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
		if (!next) folderModal = { open: false, mode: 'create', folderId: null, parentId: null };
	}}
>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Title class="text-lg font-semibold">
			{folderModal.mode !== 'create'
				? 'Edit folder'
				: folderModal.parentId
					? 'New subfolder'
					: 'New folder'}
		</Dialog.Title>
		<div class="flex items-center gap-2">
			<EmojiPicker
				value={folderEmojiInput || null}
				onSelect={(emoji) => (folderEmojiInput = emoji ?? '')}
			/>
			<Input
				value={folderNameInput}
				oninput={(e) => (folderNameInput = e.currentTarget.value)}
				onkeydown={(e) => {
					if (e.key === 'Enter') void submitFolder();
				}}
				placeholder="Folder name"
				class="flex-1"
			/>
		</div>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() =>
					(folderModal = { open: false, mode: 'create', folderId: null, parentId: null })}
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
			Delete the folder <strong>{deleteFolderModal.name}</strong>? Notes inside it are kept and
			moved back to the date list.
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
