<script lang="ts">
	import { onMount } from 'svelte';
	import { Clock3, History, Pin, Settings2, Trash2 } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import type { RecentChatThread } from '$lib/bindings';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { chat } from '$lib/stores/chat.svelte';
	import { bars } from '$lib/stores/bars.svelte';
	import { barIcon, type Bar } from '$lib/bars/catalog';
	import { barVariables } from '$lib/bars/variables';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import RunBarDialog from '$lib/components/bars/RunBarDialog.svelte';

	import ChatSurface from './ChatSurface.svelte';

	onMount(() => {
		void bars.ensureLoaded();
	});

	let barsOpen = $state(false);
	let recentOpen = $state(false);
	let clearConfirmOpen = $state(false);
	let runDialogOpen = $state(false);
	let pendingBar = $state<Bar | null>(null);
	let pendingOpen: (() => void) | null = null;
	let recentThreads = $state<RecentChatThread[]>([]);
	// The in-meeting chat starts collapsed (a "Continue chat" pill) rather than
	// expanded, so opening a meeting isn't dominated by the chat panel.
	let chatOpen = $state(false);
	const barGroups = $derived(bars.groupsForSurface('meeting'));

	// Load the meeting's persisted thread on mount and whenever the meeting
	// changes, so a conversation survives collapse, close, and navigation.
	// Sentinel (not chat.meetingId) so the first run loads too.
	let lastMeetingId: string | null | undefined;
	$effect(() => {
		const id = chat.meetingId;
		if (id !== lastMeetingId) {
			lastMeetingId = id;
			// Collapse when switching meetings: this component persists across
			// /meeting-details navigations, so each opened meeting starts closed.
			chatOpen = false;
			void chat.loadFor(id);
		}
	});

	function runBar(bar: Bar, open: () => void): void {
		if (barVariables(bar.prompt).length > 0) {
			barsOpen = false;
			pendingBar = bar;
			pendingOpen = open;
			runDialogOpen = true;
			return;
		}
		executeBar(bar, bar.prompt, open);
	}

	function executeBar(bar: Bar, prompt: string, open: () => void): void {
		barsOpen = false;
		open();
		bars.recordRun(bar);
		void chat.send(prompt, { barId: bar.id, barTitle: bar.title, barPrompt: prompt });
	}

	async function onRecentOpenChange(isOpen: boolean): Promise<void> {
		recentOpen = isOpen;
		if (isOpen) recentThreads = await chat.recentThreads();
	}

	function openRecent(thread: RecentChatThread): void {
		recentOpen = false;
		void goto(`/meeting-details?id=${thread.meeting_id}`);
	}

	async function confirmClear(): Promise<void> {
		clearConfirmOpen = false;
		await chat.clearThread();
	}
</script>

<ChatSurface
	bind:open={chatOpen}
	controller={chat}
	title="Ask anything"
	placeholder="Ask anything about this meeting…"
	collapsedPlaceholder="Continue chat"
	ariaLabel="Ask anything about this meeting"
	overlayActive={barsOpen || recentOpen || clearConfirmOpen || runDialogOpen}
>
	{#snippet headerActions()}
		<Button
			variant="ghost"
			size="icon-sm"
			class="text-muted-foreground hover:text-destructive"
			onclick={() => (clearConfirmOpen = true)}
			aria-label="Clear conversation"
		>
			<Trash2 data-icon />
		</Button>
	{/snippet}

	{#snippet rail({ open })}
		<Popover.Root bind:open={recentOpen} onOpenChange={(o) => void onRecentOpenChange(o)}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon"
						class="shrink-0 rounded-full text-muted-foreground"
						aria-label="Recent chats"
					>
						<History data-icon />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="start" side="top" class="w-80 p-0">
				<Command.Root>
					<Command.List>
						{#if recentThreads.length === 0}
							<div class="p-4 text-center text-sm text-muted-foreground">No chats yet.</div>
						{:else}
							<Command.Group heading="Recent chats">
								{#each recentThreads as thread (thread.meeting_id)}
									<Command.Item
										value={`${thread.meeting_title} ${thread.first_question}`}
										onSelect={() => openRecent(thread)}
									>
										<div class="flex min-w-0 flex-col">
											<span class="truncate text-sm">{thread.meeting_title || 'Untitled'}</span>
											<span class="truncate text-xs text-muted-foreground">
												{thread.first_question}
											</span>
										</div>
									</Command.Item>
								{/each}
							</Command.Group>
						{/if}
					</Command.List>
				</Command.Root>
			</Popover.Content>
		</Popover.Root>

		<Popover.Root bind:open={barsOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon"
						disabled={chat.isStreaming}
						class="shrink-0 rounded-full text-muted-foreground"
						aria-label="Muesly bars"
					>
						<MueslyBar class="size-4" />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="start" side="top" class="w-64 p-0">
				<Command.Root>
					<Command.Input placeholder="Search bars…" />
					<Command.List>
						<Command.Empty>No bars yet.</Command.Empty>
						{#each [{ label: 'Pinned', items: barGroups.pinned }, { label: 'Recent', items: barGroups.recent }, { label: 'Muesly bars', items: barGroups.all }] as group (group.label)}
							{#if group.items.length > 0}
								<Command.Group heading={group.label}>
									{#each group.items as bar (bar.id)}
										{@const Icon = barIcon(bar.icon)}
										<Command.Item value={bar.title} onSelect={() => runBar(bar, open)}>
											<Icon class="size-4 text-muted-foreground" />
											<span>{bar.title}</span>
											{#if bars.isPinned(bar)}
												<Pin class="ml-auto size-3 text-muted-foreground" />
											{:else if bars.isRecent(bar)}
												<Clock3 class="ml-auto size-3 text-muted-foreground" />
											{/if}
										</Command.Item>
									{/each}
								</Command.Group>
							{/if}
						{/each}
						<Command.Separator />
						<Command.Group>
							<Command.Item value="Manage Muesly bars" onSelect={() => void goto('/bars')}>
								<Settings2 class="size-4 text-muted-foreground" />
								<span>Manage bars</span>
							</Command.Item>
						</Command.Group>
					</Command.List>
				</Command.Root>
			</Popover.Content>
		</Popover.Root>
	{/snippet}
</ChatSurface>

<Dialog.Root bind:open={clearConfirmOpen}>
	<Dialog.Content class="sm:max-w-[400px]">
		<Dialog.Title>Clear this chat?</Dialog.Title>
		<Dialog.Description>
			The conversation for this meeting will be permanently deleted.
		</Dialog.Description>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (clearConfirmOpen = false)}>Cancel</Button>
			<Button variant="destructive" onclick={() => void confirmClear()}>Clear chat</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<RunBarDialog
	bind:open={runDialogOpen}
	bar={pendingBar}
	onRun={(prompt) => pendingBar && executeBar(pendingBar, prompt, pendingOpen ?? (() => {}))}
/>
