<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, Folder, Search } from '@lucide/svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { cn } from '$lib/utils';
	import { compareByDateDesc } from '$lib/date-groups';
	import { sidebar } from '$lib/stores/sidebar.svelte';

	// Optional folder scope, passed by the trigger when a folder is being viewed.
	const scopeFolderId = $derived(page.url.searchParams.get('folder'));
	const scopeFolder = $derived(
		scopeFolderId ? (sidebar.folders.find((f) => f.id === scopeFolderId) ?? null) : null
	);

	let query = $state('');
	// 'folder' restricts to scopeFolder; 'all' searches everything. Starts scoped.
	let scope = $state<'all' | 'folder'>('folder');
	const effectiveScopeId = $derived(scope === 'folder' && scopeFolder ? scopeFolder.id : null);

	// Title matches are computed locally and instantly; transcript matches arrive
	// via the debounced store call (api_search_transcripts populates searchResults).
	let debounce: ReturnType<typeof setTimeout> | undefined;
	function onInput(value: string): void {
		query = value;
		clearTimeout(debounce);
		const q = value.trim();
		debounce = setTimeout(() => void sidebar.searchTranscripts(q), 150);
	}

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const matchedIds = new Set(sidebar.searchResults.map((r) => r.id));
		return sidebar.meetings
			.filter((m) => {
				if (effectiveScopeId && m.folderId !== effectiveScopeId) return false;
				return matchedIds.has(m.id) || m.title.toLowerCase().includes(q);
			})
			.sort((a, b) => compareByDateDesc(a.createdAt, b.createdAt));
	});

	function snippet(id: string): string | null {
		return sidebar.searchResults.find((r) => r.id === id)?.matchContext ?? null;
	}
	function folderName(id?: string): string | null {
		return id ? (sidebar.folders.find((f) => f.id === id)?.name ?? null) : null;
	}
	function openMeeting(id: string): void {
		void goto(`/meeting-details?id=${id}`);
	}
	function formatWhen(iso?: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function goBack(): void {
		history.back();
	}

	onMount(() => {
		document.getElementById('search-input')?.focus();
		const handleKeydown = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				e.preventDefault();
				goBack();
			} else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '[') {
				e.preventDefault();
				goBack();
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => {
			clearTimeout(debounce);
			window.removeEventListener('keydown', handleKeydown);
		};
	});
</script>

<div class="flex h-screen flex-col bg-background">
	<div class="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm">
		<div
			data-tauri-drag-region="deep"
			class={cn(
				'relative flex h-9 items-center pr-3 transition-[padding] duration-300',
				sidebar.isCollapsed ? 'pl-[6.5rem]' : 'pl-3'
			)}
		>
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								onclick={goBack}
								variant="ghost"
								size="icon-sm"
								class="text-muted-foreground hover:text-foreground"
								aria-label="Back"
							>
								<ArrowLeft />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>
						Back
						<span class="tracking-wide opacity-60">esc</span>
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
			<h1
				class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[13px] font-medium text-muted-foreground"
			>
				Search
			</h1>
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto max-w-3xl p-8 pt-6">
			<div class="relative">
				<Search
					class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					id="search-input"
					class="h-11 pl-9 text-base"
					placeholder={scopeFolder ? `Search notes in ${scopeFolder.name}` : 'Search all notes'}
					aria-label="Search notes"
					value={query}
					oninput={(e) => onInput(e.currentTarget.value)}
				/>
			</div>

			{#if scopeFolder}
				<div class="mt-3 flex items-center gap-1.5">
					<Button
						variant={scope === 'all' ? 'secondary' : 'ghost'}
						size="sm"
						onclick={() => (scope = 'all')}
					>
						All notes
					</Button>
					<Button
						variant={scope === 'folder' ? 'secondary' : 'ghost'}
						size="sm"
						onclick={() => (scope = 'folder')}
					>
						<Folder data-icon="inline-start" />
						In {scopeFolder.name}
					</Button>
				</div>
			{/if}

			<div class="mt-5">
				{#if !query.trim()}
					<div class="py-20 text-center text-sm text-muted-foreground">
						Type to search across your notes and transcripts.
					</div>
				{:else if results.length === 0}
					<div class="py-16 text-center text-sm text-muted-foreground">
						{sidebar.isSearching ? 'Searching…' : `No notes match “${query.trim()}”.`}
					</div>
				{:else}
					<div class="flex flex-col gap-2">
						{#each results as meeting (meeting.id)}
							{@const inFolder = !effectiveScopeId ? folderName(meeting.folderId) : null}
							{@const context = snippet(meeting.id)}
							<button
								type="button"
								onclick={() => openMeeting(meeting.id)}
								class="group flex w-full flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-secondary"
							>
								<div class="flex items-center justify-between gap-3">
									<span class="min-w-0 truncate font-medium text-foreground">{meeting.title}</span>
									<span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
										{#if inFolder}
											<span class="flex items-center gap-1">
												<Folder class="size-3" />
												{inFolder}
											</span>
										{/if}
										{#if formatWhen(meeting.createdAt)}
											<span>{formatWhen(meeting.createdAt)}</span>
										{/if}
									</span>
								</div>
								{#if context}
									<span class="line-clamp-2 text-xs text-muted-foreground">{context}</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
