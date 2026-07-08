<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Check, Folder, FolderPlus, Lock, RefreshCw } from '@lucide/svelte';

	import type { PreviewEvent } from '$lib/bindings';
	import { commands } from '$lib/bindings';
	import { formatEventTime } from '$lib/coming-up';
	import { cn } from '$lib/utils';
	import { toast } from '$lib/toast';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { startRecordingWithTitle } from '$lib/hooks/use-recording-start.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';

	interface Props {
		ev: PreviewEvent;
		/** Reactive clock (ms) owned by the parent, so the Start button appears/hides live. */
		nowMs: number;
	}
	let { ev, nowMs }: Props = $props();

	const startMs = $derived(new Date(ev.start).getTime());
	const endMs = $derived(ev.end ? new Date(ev.end).getTime() : startMs + 60 * 60000);
	const minutesUntilStart = $derived((startMs - nowMs) / 60000);
	// Exclude all-day (~24h) blocks from the Start affordance; those aren't meetings.
	const isTimed = $derived((endMs - startMs) / 60000 > 0 && (endMs - startMs) / 60000 <= 12 * 60);
	// Actionable when the meeting is starting soon (≤15 min) or already in progress,
	// and hasn't ended. In-progress events are kept in the card upstream.
	const showStart = $derived(
		isTimed && minutesUntilStart <= 15 && nowMs < endMs && !recordingState.isRecording,
	);

	const canAssign = $derived(!!ev.ical_uid);

	// Folder pre-assignment.
	let assignedFolderId = $state<string | null>(null);
	let pickerOpen = $state(false);
	let mode = $state<'pick' | 'recurring'>('pick');
	let query = $state('');

	const folders = $derived(sidebar.folders);
	const assignedFolder = $derived(folders.find((f) => f.id === assignedFolderId) ?? null);
	// Hide the add-to-folder pill until the row is hovered, unless its picker is open
	// or a folder is already assigned.
	const pillHidden = $derived(!pickerOpen && !assignedFolder);
	const canCreate = $derived(
		query.trim().length > 0 &&
			!folders.some((f) => f.name.toLowerCase() === query.trim().toLowerCase()),
	);
	function folderCount(id: string): number {
		return sidebar.meetings.filter((m) => m.folderId === id).length;
	}

	// True once the user has touched the assignment, so a slow hydration response
	// can't clobber a fresh pick (TOCTOU).
	let touched = false;

	onMount(() => {
		if (!ev.ical_uid) return;
		void commands.calendarGetEventFolder(ev.ical_uid, ev.occurrence_minute).then((res) => {
			if (!touched && res.status === 'ok') assignedFolderId = res.data;
		});
	});

	async function assign(folderId: string, autoAddSeries = false): Promise<void> {
		if (!ev.ical_uid) return;
		touched = true;
		// Re-selecting the already-assigned folder is a no-op — otherwise it would
		// write a per-occurrence rule (overriding a series rule) and re-prompt.
		if (!autoAddSeries && folderId === assignedFolderId) {
			pickerOpen = false;
			return;
		}
		const res = await commands.calendarSetEventFolder(
			ev.ical_uid,
			null,
			ev.occurrence_minute,
			folderId,
			autoAddSeries,
		);
		if (res.status === 'error') {
			toast.error('Failed to set folder', { description: res.error });
			return;
		}
		assignedFolderId = folderId;
		query = '';
		// For a recurring meeting, offer to apply the folder to the whole series.
		if (ev.is_recurring && !autoAddSeries) {
			mode = 'recurring';
		} else {
			pickerOpen = false;
		}
	}

	async function unassign(): Promise<void> {
		if (!ev.ical_uid) return;
		touched = true;
		const res = await commands.calendarClearEventFolder(ev.ical_uid, ev.occurrence_minute);
		if (res.status === 'error') {
			toast.error('Failed to clear folder', { description: res.error });
			return;
		}
		assignedFolderId = null;
		pickerOpen = false;
	}

	async function createAndAssign(): Promise<void> {
		const name = query.trim();
		if (!name) return;
		touched = true;
		await sidebar.createFolder(name);
		const created = sidebar.folders.find((f) => f.name === name);
		if (created) {
			await assign(created.id);
		} else {
			toast.error('Folder created', { description: 'Pick it from the list to assign it.' });
			pickerOpen = false;
		}
	}

	async function confirmAutoAdd(): Promise<void> {
		if (assignedFolderId) await assign(assignedFolderId, true);
		pickerOpen = false;
	}

	function onPickerOpenChange(open: boolean): void {
		pickerOpen = open;
		if (!open) mode = 'pick';
	}

	async function onStart(): Promise<void> {
		const pin = ev.ical_uid
			? { icalUid: ev.ical_uid, occurrenceMinute: ev.occurrence_minute }
			: undefined;
		await startRecordingWithTitle(ev.title, 'coming_up', pin);
		void goto('/note');
	}
</script>

<div class="group flex items-start gap-3">
	<div class="mt-0.5 h-8 w-0.5 flex-shrink-0 rounded-full bg-success/60"></div>
	<div class="min-w-0 flex-1">
		<div class="truncate text-sm font-medium">{ev.title}</div>
		<div class="truncate text-xs text-muted-foreground">
			{formatEventTime(ev.start)}
			{#if ev.calendar_name}
				· {ev.calendar_name}
			{/if}
		</div>
	</div>

	<div class="flex flex-shrink-0 items-center gap-1.5">
		{#if showStart}
			<Button size="sm" variant="secondary" onclick={onStart}>Start</Button>
		{/if}

		{#if canAssign}
			<Popover.Root bind:open={pickerOpen} onOpenChange={onPickerOpenChange}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							size="sm"
							variant="ghost"
							class={cn(
								'max-w-[11rem] text-muted-foreground',
								pillHidden && 'invisible group-hover:visible',
							)}
							aria-label="Add to folder"
						>
							{#if assignedFolder}
								{#if assignedFolder.emoji}
									<span data-icon="inline-start">{assignedFolder.emoji}</span>
								{:else}
									<Folder data-icon="inline-start" />
								{/if}
								<span class="truncate">{assignedFolder.name}</span>
							{:else}
								<Folder data-icon="inline-start" />
								Add to folder
							{/if}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="end" class="w-64 p-0">
					{#if mode === 'pick'}
						<Command.Root>
							<Command.Input placeholder="Search folders" bind:value={query} />
							<Command.List>
								<Command.Empty>No folders match.</Command.Empty>
								<Command.Group>
									<Command.Item value="My notes" onSelect={unassign}>
										<Lock class="size-4 text-muted-foreground" />
										<span>My notes</span>
										{#if !assignedFolderId}<Check class="ml-auto size-4" />{/if}
									</Command.Item>
									{#each folders as f (f.id)}
										<Command.Item value={f.name} onSelect={() => assign(f.id)}>
											{#if f.emoji}
												<span>{f.emoji}</span>
											{:else}
												<Folder class="size-4 text-muted-foreground" />
											{/if}
											<span class="truncate">{f.name}</span>
											<span class="ml-auto text-xs tabular-nums text-muted-foreground">
												{folderCount(f.id)}
											</span>
											{#if assignedFolderId === f.id}<Check class="size-4" />{/if}
										</Command.Item>
									{/each}
								</Command.Group>
								{#if canCreate}
									<Command.Separator />
									<Command.Item value={`Create ${query}`} onSelect={createAndAssign}>
										<FolderPlus class="size-4 text-accent" />
										<span class="text-accent">Create “{query.trim()}”</span>
									</Command.Item>
								{/if}
							</Command.List>
						</Command.Root>
					{:else}
						<div class="p-3">
							<div class="flex items-center gap-2 text-sm font-medium">
								<RefreshCw class="size-4" />
								Auto-add future meetings?
							</div>
							<p class="mt-1 text-xs text-muted-foreground">
								Automatically put all future instances of this recurring meeting into this folder.
							</p>
							<div class="mt-3 flex gap-2">
								<Button size="sm" onclick={confirmAutoAdd}>Auto-add</Button>
								<Button size="sm" variant="outline" onclick={() => (pickerOpen = false)}>No</Button>
							</div>
						</div>
					{/if}
				</Popover.Content>
			</Popover.Root>
		{/if}
	</div>
</div>
