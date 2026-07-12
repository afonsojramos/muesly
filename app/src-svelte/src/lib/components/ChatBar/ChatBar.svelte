<script lang="ts">
	import {
		ArrowUp,
		ChevronDown,
		History,
		MessagesSquare,
		Sparkles,
		Square,
		Trash2,
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import { cn } from '$lib/utils';
	import type { RecentChatThread } from '$lib/bindings';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { Textarea } from '$lib/components/ui/textarea';
	import { chat } from '$lib/stores/chat.svelte';

	import { RECIPES, type Recipe } from './recipes';

	let recipesOpen = $state(false);
	let recentOpen = $state(false);
	let clearConfirmOpen = $state(false);
	let panelOpen = $state(true);
	let rootEl = $state<HTMLElement | null>(null);
	let viewportRef = $state<HTMLElement | null>(null);
	let recentThreads = $state<RecentChatThread[]>([]);

	const hasMessages = $derived(chat.messages.length > 0);

	// Load the meeting's persisted thread on mount and whenever the meeting
	// changes, so a conversation survives collapse, close, and navigation.
	// Sentinel (not chat.meetingId) so the first run loads too.
	let lastMeetingId: string | null | undefined;
	$effect(() => {
		const id = chat.meetingId;
		if (id !== lastMeetingId) {
			lastMeetingId = id;
			void chat.loadFor(id);
		}
	});

	// Keep the newest content in view as tokens stream / turns are added.
	const lastContent = $derived(chat.messages.at(-1)?.content ?? '');
	$effect(() => {
		// Track both signals.
		void lastContent;
		void chat.messages.length;
		viewportRef?.scrollTo({ top: viewportRef.scrollHeight });
	});

	// Clicking outside the bar collapses the conversation panel (it never
	// deletes anything — the thread is persisted). Portaled layers (popovers,
	// the clear-confirmation dialog) render outside the root, so clicks inside
	// them must not count as "outside".
	function onDocumentPointerDown(event: PointerEvent): void {
		if (!panelOpen || !hasMessages) return;
		const target = event.target as Element | null;
		if (!target) return;
		if (rootEl?.contains(target)) return;
		if (
			target.closest(
				'[data-slot="popover-content"], [data-slot="dialog-content"], [data-slot="dialog-overlay"]',
			)
		) {
			return;
		}
		panelOpen = false;
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		// Esc collapses the panel. Leave it to portaled layers when one is open —
		// including the same keypress that just closed one (bits-ui updates state
		// before this window-level handler runs, so also honor defaultPrevented).
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		if (recipesOpen || recentOpen || clearConfirmOpen) return;
		if (panelOpen && hasMessages) panelOpen = false;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void submit();
		}
	}

	async function submit(): Promise<void> {
		if (chat.isStreaming || !chat.draft.trim()) return;
		panelOpen = true;
		await chat.send();
	}

	function runRecipe(recipe: Recipe): void {
		recipesOpen = false;
		panelOpen = true;
		void chat.send(recipe.prompt);
	}

	async function onRecentOpenChange(open: boolean): Promise<void> {
		recentOpen = open;
		if (open) recentThreads = await chat.recentThreads();
	}

	function openRecent(thread: RecentChatThread): void {
		recentOpen = false;
		panelOpen = true;
		void goto(`/meeting-details?id=${thread.meeting_id}`);
	}

	async function confirmClear(): Promise<void> {
		clearConfirmOpen = false;
		await chat.clearThread();
	}
</script>

<svelte:document onpointerdown={onDocumentPointerDown} />
<svelte:window onkeydown={onWindowKeydown} />

<div bind:this={rootEl} class="flex w-[min(42rem,calc(100vw-3rem))] flex-col gap-2">
	{#if hasMessages && panelOpen}
		<div
			class="flex max-h-[min(60vh,32rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_12px_rgb(0,0,0,0.1)]"
		>
			<div class="flex items-center justify-between border-b border-border px-4 py-2">
				<span class="text-sm font-medium">Ask anything</span>
				<div class="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						class="text-muted-foreground hover:text-destructive"
						onclick={() => (clearConfirmOpen = true)}
						aria-label="Clear conversation"
					>
						<Trash2 data-icon />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => (panelOpen = false)}
						aria-label="Collapse conversation"
					>
						<ChevronDown data-icon />
					</Button>
				</div>
			</div>
			<!-- Plain overflow container: ScrollArea's viewport never receives a
			     height bound inside this flex column, which clipped instead of
			     scrolling. Native overflow just works. -->
			<div bind:this={viewportRef} class="min-h-0 flex-1 overflow-y-auto">
				<div class="flex flex-col gap-3 p-4" aria-live="polite" aria-atomic="false">
					{#each chat.messages as message (message.id)}
						<div class={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
							<div
								class={cn(
									'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm',
									message.role === 'user'
										? 'bg-primary text-primary-foreground'
										: 'bg-secondary text-secondary-foreground',
								)}
							>
								{#if message.content}
									{message.content}
								{:else}
									<span class="text-muted-foreground">Thinking…</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<div
		class="flex items-end gap-1.5 rounded-[1.75rem] border border-border bg-card py-1.5 pl-1.5 pr-2 shadow-[0_2px_12px_rgb(0,0,0,0.1)]"
	>
		{#if hasMessages && !panelOpen}
			<Button
				variant="ghost"
				size="icon"
				class="shrink-0 rounded-full text-muted-foreground"
				onclick={() => (panelOpen = true)}
				aria-label="Show conversation"
			>
				<MessagesSquare data-icon />
			</Button>
		{/if}

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

		<Popover.Root bind:open={recipesOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon"
						disabled={chat.isStreaming}
						class="shrink-0 rounded-full text-muted-foreground"
						aria-label="Prompt recipes"
					>
						<Sparkles data-icon />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="start" side="top" class="w-64 p-0">
				<Command.Root>
					<Command.List>
						<Command.Group heading="Recipes">
							{#each RECIPES as recipe (recipe.id)}
								<Command.Item value={recipe.label} onSelect={() => runRecipe(recipe)}>
									<recipe.icon class="size-4 text-muted-foreground" />
									<span>{recipe.label}</span>
								</Command.Item>
							{/each}
						</Command.Group>
					</Command.List>
				</Command.Root>
			</Popover.Content>
		</Popover.Root>

		<Textarea
			bind:value={chat.draft}
			onkeydown={handleKeydown}
			onfocus={() => {
				if (hasMessages) panelOpen = true;
			}}
			placeholder={hasMessages && !panelOpen ? 'Continue chat' : 'Ask anything about this meeting…'}
			aria-label="Ask anything about this meeting"
			rows={1}
			class="max-h-40 min-h-0 flex-1 resize-none self-center border-0 bg-transparent py-2 shadow-none focus-visible:ring-0"
		/>

		{#if chat.isStreaming}
			<Button
				variant="secondary"
				size="icon"
				class="shrink-0 rounded-full"
				onclick={() => chat.stop()}
				aria-label="Stop generating"
			>
				<Square data-icon />
			</Button>
		{:else}
			<Button
				size="icon"
				class="shrink-0 rounded-full"
				disabled={!chat.draft.trim()}
				onclick={submit}
				aria-label="Send"
			>
				<ArrowUp data-icon />
			</Button>
		{/if}
	</div>
</div>

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
