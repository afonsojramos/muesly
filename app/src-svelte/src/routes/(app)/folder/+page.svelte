<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, ChevronRight, Folder } from '@lucide/svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import { sidebar } from '$lib/stores/sidebar.svelte';

	const folderId = $derived(page.url.searchParams.get('id'));
	const folder = $derived(sidebar.folders.find((f) => f.id === folderId) ?? null);

	// Newest first; ISO strings sort chronologically, so a lexical compare is enough.
	const meetings = $derived(
		folderId
			? sidebar.meetings
					.filter((m) => m.folderId === folderId)
					.toSorted((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
			: []
	);

	function goBack(): void {
		history.back();
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

	// Standard macOS "back" shortcut, matching the title-bar tooltip hint.
	onMount(() => {
		const handleKeydown = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '[') {
				e.preventDefault();
				goBack();
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
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
						<span class="tracking-wide opacity-60">⌘[</span>
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
			<h1
				class="pointer-events-none absolute left-1/2 max-w-[50%] -translate-x-1/2 truncate text-[13px] font-medium text-muted-foreground"
			>
				{folder?.name ?? 'Folder'}
			</h1>
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto max-w-3xl p-8 pt-6">
			{#if !folder}
				<!-- Folder missing: deleted, or opened via a stale link. -->
				<div class="flex flex-col items-center gap-3 py-24 text-center">
					<Folder class="size-10 text-muted-foreground/40" />
					<p class="text-sm text-muted-foreground">This folder no longer exists.</p>
					<Button variant="outline" size="sm" onclick={() => goto('/')}>Go home</Button>
				</div>
			{:else}
				<header class="mb-6 flex items-center gap-3">
					<div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
						<Folder class="size-5 text-muted-foreground" />
					</div>
					<div class="min-w-0">
						<h2 class="truncate text-xl font-semibold text-foreground">{folder.name}</h2>
						<p class="text-sm text-muted-foreground">
							{meetings.length}
							{meetings.length === 1 ? 'note' : 'notes'}
						</p>
					</div>
				</header>

				{#if meetings.length === 0}
					<div class="flex flex-col items-center gap-2 py-20 text-center">
						<p class="text-sm text-muted-foreground">No notes in this folder yet.</p>
						<p class="text-xs text-muted-foreground/70">
							Drag a note onto this folder in the sidebar to add it here.
						</p>
					</div>
				{:else}
					<div class="flex flex-col gap-2">
						{#each meetings as meeting (meeting.id)}
							<button
								type="button"
								onclick={() => openMeeting(meeting.id)}
								class="group flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-secondary"
							>
								<div class="min-w-0">
									<div class="truncate font-medium text-foreground">{meeting.title}</div>
									{#if formatWhen(meeting.createdAt)}
										<div class="mt-0.5 text-xs text-muted-foreground">
											{formatWhen(meeting.createdAt)}
										</div>
									{/if}
								</div>
								<ChevronRight
									class="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
								/>
							</button>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
