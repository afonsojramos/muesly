<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Clock3, Pin, Settings2, Trash2 } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import Spinner from '$lib/components/Spinner.svelte';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import { globalChat, type GlobalChatMessage } from '$lib/stores/global-chat.svelte';
	import { bars } from '$lib/stores/bars.svelte';
	import { barIcon, type Bar } from '$lib/bars/catalog';
	import { barVariables } from '$lib/bars/variables';
	import RunBarDialog from '$lib/components/bars/RunBarDialog.svelte';

	import ChatSurface, { type ChatSurfaceMessage } from './ChatSurface.svelte';

	let barsOpen = $state(false);
	let runDialogOpen = $state(false);
	let pendingBar = $state<Bar | null>(null);
	let pendingOpen: (() => void) | null = null;
	const barGroups = $derived(bars.groupsForSurface('global'));

	onMount(() => {
		void bars.ensureLoaded();
	});

	// The surface passes the shared message shape; the store's messages carry the
	// extra `actions` we render as agent steps.
	function actionsOf(message: ChatSurfaceMessage): GlobalChatMessage['actions'] {
		return (message as GlobalChatMessage).actions ?? [];
	}

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
		void globalChat.send(prompt, { barId: bar.id, barTitle: bar.title, barPrompt: prompt });
	}
</script>

<ChatSurface
	controller={globalChat}
	title="Ask your meetings"
	placeholder="Ask across all your meetings…"
	collapsedPlaceholder="Ask your meetings"
	ariaLabel="Ask across all your meetings"
	emptyLabel="No answer produced."
	overlayActive={barsOpen || runDialogOpen}
	hideEmptyBubbleWhileStreaming
>
	{#snippet headerActions()}
		<Button
			variant="ghost"
			size="icon-sm"
			class="text-muted-foreground hover:text-destructive"
			disabled={globalChat.isStreaming}
			onclick={() => globalChat.clear()}
			aria-label="Clear conversation"
		>
			<Trash2 data-icon />
		</Button>
	{/snippet}

	{#snippet rail({ open })}
		<Popover.Root bind:open={barsOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon"
						disabled={globalChat.isStreaming}
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

	{#snippet messageLeading(message)}
		{@const actions = actionsOf(message)}
		{#if actions.length > 0}
			<!-- The agent's visible steps: search/read progress checked off as each
			     tool finishes. -->
			<div class="flex flex-col gap-1 px-1">
				{#each actions as action (action.id)}
					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						{#if action.done}
							<Check class="size-3.5 shrink-0 text-brand" />
						{:else}
							<Spinner class="size-3.5 shrink-0" />
						{/if}
						<span class="truncate">{action.label}</span>
						{#if action.detail}
							<span class="shrink-0 text-muted-foreground/60">· {action.detail}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}
</ChatSurface>

<RunBarDialog
	bind:open={runDialogOpen}
	bar={pendingBar}
	onRun={(prompt) => pendingBar && executeBar(pendingBar, prompt, pendingOpen ?? (() => {}))}
/>
