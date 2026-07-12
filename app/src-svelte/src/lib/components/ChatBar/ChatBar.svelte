<script lang="ts">
	import { History, Sparkles, Trash2 } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import type { RecentChatThread } from '$lib/bindings';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { chat } from '$lib/stores/chat.svelte';

	import ChatSurface from './ChatSurface.svelte';
	import { RECIPES, type Recipe } from './recipes';

	let recipesOpen = $state(false);
	let recentOpen = $state(false);
	let clearConfirmOpen = $state(false);
	let recentThreads = $state<RecentChatThread[]>([]);

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

	function runRecipe(recipe: Recipe, open: () => void): void {
		recipesOpen = false;
		open();
		void chat.send(recipe.prompt);
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
	controller={chat}
	title="Ask anything"
	placeholder="Ask anything about this meeting…"
	collapsedPlaceholder="Continue chat"
	ariaLabel="Ask anything about this meeting"
	overlayActive={recipesOpen || recentOpen || clearConfirmOpen}
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
								<Command.Item value={recipe.label} onSelect={() => runRecipe(recipe, open)}>
									<recipe.icon class="size-4 text-muted-foreground" />
									<span>{recipe.label}</span>
								</Command.Item>
							{/each}
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
