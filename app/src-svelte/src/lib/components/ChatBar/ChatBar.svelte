<script lang="ts">
	import { onMount } from 'svelte';
	import {
		AudioLines,
		Clock3,
		History,
		Pin,
		Settings2,
		Trash2,
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import type { RecentChatThread } from '$lib/bindings';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { chat } from '$lib/stores/chat.svelte';
	import { bars } from '$lib/stores/bars.svelte';
	import { liveTranscriptPanel } from '$lib/stores/live-transcript-panel.svelte';
	import { sidePanelState } from '$lib/stores/side-panel.svelte';
	import { barCommandSlugs, barIcon, type Bar } from '$lib/bars/catalog';
	import { barVariables } from '$lib/bars/variables';
	import { addBarInstructions } from '$lib/bars/execution';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import RunBarDialog from '$lib/components/bars/RunBarDialog.svelte';

	import ChatSurface from './ChatSurface.svelte';
	import ChatRailButton from './ChatRailButton.svelte';

	onMount(() => {
		void bars.ensureLoaded();
	});

	let barsOpen = $state(false);
	let recentOpen = $state(false);
	let clearConfirmOpen = $state(false);
	let runDialogOpen = $state(false);
	let pendingBar = $state<Bar | null>(null);
	let pendingOpen: (() => void) | null = null;
	let pendingAdditionalInstructions = '';
	let recentThreads = $state<RecentChatThread[]>([]);
	// The in-meeting chat starts collapsed (a "Continue chat" pill) rather than
	// expanded, so opening a meeting isn't dominated by the chat panel.
	let chatOpen = $state(false);
	const barGroups = $derived(bars.groupsForSurface('meeting'));
	const slashCommands = $derived.by(() => {
		const items = bars.forSurface('meeting');
		const slugs = barCommandSlugs(items);
		return items.map((bar) => ({
			id: bar.id,
			slug: slugs.get(bar.id)!,
			label: bar.title,
			description: bar.description,
			icon: barIcon(bar.icon),
			run: (open: () => void, additionalInstructions?: string) =>
				runBar(bar, open, additionalInstructions),
		}));
	});
	const isLiveNote = $derived(page.url.pathname === '/note');
	const transcriptPanelOpen = $derived(isLiveNote ? liveTranscriptPanel.open : sidePanelState.open);
	const transcriptPanelLabel = $derived(isLiveNote ? 'transcript' : 'transcript & notes');

	function toggleTranscriptPanel(): void {
		if (isLiveNote) liveTranscriptPanel.toggle();
		else sidePanelState.toggle();
	}

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

	function runBar(bar: Bar, open: () => void, additionalInstructions?: string): void {
		if (barVariables(bar.prompt).length > 0) {
			barsOpen = false;
			pendingBar = bar;
			pendingOpen = open;
			pendingAdditionalInstructions = additionalInstructions ?? '';
			runDialogOpen = true;
			return;
		}
		executeBar(bar, addBarInstructions(bar.prompt, additionalInstructions), open, additionalInstructions);
	}

	function executeBar(
		bar: Bar,
		prompt: string,
		open: () => void,
		additionalInstructions?: string,
	): void {
		barsOpen = false;
		open();
		bars.recordRun(bar);
		void chat.send(prompt, {
			barId: bar.id,
			barTitle: bar.title,
			barPrompt: prompt,
			barContext: additionalInstructions?.trim() || undefined,
		});
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
	{slashCommands}
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
		<ChatRailButton
			tooltip={`${transcriptPanelOpen ? 'Hide' : 'Show'} ${transcriptPanelLabel}`}
			ariaLabel={`${transcriptPanelOpen ? 'Hide' : 'Show'} ${transcriptPanelLabel}`}
			shortcut="⌘T"
			pressed={transcriptPanelOpen}
			onclick={toggleTranscriptPanel}
		>
			<AudioLines
				data-icon
				class="transcript-audio-lines transition-colors duration-200 ease-out group-hover:text-brand"
			/>
		</ChatRailButton>

		<Popover.Root bind:open={recentOpen} onOpenChange={(o) => void onRecentOpenChange(o)}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<ChatRailButton
						triggerProps={props}
						tooltip="Recent meeting chats"
						ariaLabel="Recent chats"
						overlayOpen={recentOpen}
					>
						<History data-icon />
					</ChatRailButton>
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
					<ChatRailButton
						triggerProps={props}
						tooltip="Run a reusable Muesly bar"
						ariaLabel="Muesly bars"
						disabled={chat.isStreaming}
						overlayOpen={barsOpen}
					>
						<MueslyBar class="size-4" />
					</ChatRailButton>
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
	onRun={(prompt) =>
		pendingBar &&
		executeBar(
			pendingBar,
			addBarInstructions(prompt, pendingAdditionalInstructions),
			pendingOpen ?? (() => {}),
			pendingAdditionalInstructions,
		)}
/>

<style>
	:global(.transcript-audio-lines path) {
		transform-box: fill-box;
		transform-origin: center;
	}

	:global(.group:hover .transcript-audio-lines path) {
		animation: transcript-audio-bar 500ms ease-in-out infinite alternate;
	}

	:global(.group:hover .transcript-audio-lines path:nth-child(2n)) {
		animation-delay: -250ms;
	}

	:global(.group:hover .transcript-audio-lines path:nth-child(3n)) {
		animation-delay: -125ms;
	}

	@keyframes transcript-audio-bar {
		from {
			transform: scaleY(0.55);
		}
		to {
			transform: scaleY(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.group:hover .transcript-audio-lines path) {
			animation: none;
		}
	}
</style>
