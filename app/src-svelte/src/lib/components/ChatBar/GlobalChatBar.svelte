<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Clock3, Folder, Pin, Settings2, Trash2 } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import Spinner from '$lib/components/Spinner.svelte';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import * as Select from '$lib/components/ui/select';
	import { globalChat, type GlobalChatMessage } from '$lib/stores/global-chat.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { bars } from '$lib/stores/bars.svelte';
	import { barCommandSlugs, barIcon, type Bar } from '$lib/bars/catalog';
	import { barVariables } from '$lib/bars/variables';
	import { addBarInstructions } from '$lib/bars/execution';
	import RunBarDialog from '$lib/components/bars/RunBarDialog.svelte';

	import ChatSurface, { type ChatSurfaceMessage } from './ChatSurface.svelte';
	import ChatRailButton from './ChatRailButton.svelte';

	let barsOpen = $state(false);
	let runDialogOpen = $state(false);
	const scopeLabel = $derived(
		globalChat.scopeFolderId
			? (sidebar.folders.find((f) => f.id === globalChat.scopeFolderId)?.name ?? 'Folder')
			: 'All meetings',
	);
	let pendingBar = $state<Bar | null>(null);
	let pendingOpen: (() => void) | null = null;
	let pendingAdditionalInstructions = '';
	const barGroups = $derived(bars.groupsForSurface('global'));
	const slashCommands = $derived.by(() => {
		const items = bars.forSurface('global');
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

	onMount(() => {
		void bars.ensureLoaded();
	});

	// The surface passes the shared message shape; the store's messages carry the
	// extra `actions` we render as agent steps.
	function actionsOf(message: ChatSurfaceMessage): GlobalChatMessage['actions'] {
		return (message as GlobalChatMessage).actions ?? [];
	}

	function runBar(bar: Bar, open: () => void, additionalInstructions?: string): void {
		if (barVariables(bar.prompt).length > 0) {
			barsOpen = false;
			pendingBar = bar;
			pendingOpen = open;
			pendingAdditionalInstructions = additionalInstructions ?? '';
			runDialogOpen = true;
			return;
		}
		executeBar(
			bar,
			addBarInstructions(bar.prompt, additionalInstructions),
			open,
			additionalInstructions,
		);
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
		void globalChat.send(prompt, {
			barId: bar.id,
			barTitle: bar.title,
			barPrompt: prompt,
			barContext: additionalInstructions?.trim() || undefined,
		});
	}
</script>

<ChatSurface
	controller={globalChat}
	title="Ask your meetings"
	placeholder="Ask across all your meetings…"
	collapsedPlaceholder="Ask your meetings"
	ariaLabel="Ask across all your meetings"
	{slashCommands}
	emptyLabel="No answer produced."
	overlayActive={barsOpen || runDialogOpen}
	hideEmptyBubbleWhileStreaming
>
	{#snippet headerActions()}
		<Select.Root
			type="single"
			value={globalChat.scopeFolderId ?? ''}
			onValueChange={(value) => (globalChat.scopeFolderId = value === '' ? null : value)}
		>
			<Select.Trigger
			class="h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-secondary hover:text-foreground"
				aria-label="Chat scope"
			>
				<Folder class="size-3.5" />
				{scopeLabel}
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					<Select.Item value="" label="All meetings">All meetings</Select.Item>
					{#each sidebar.folders as folder (folder.id)}
						<Select.Item value={folder.id} label={folder.name}>
							{folder.emoji}{folder.name}
						</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
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
					<ChatRailButton
						triggerProps={props}
						tooltip="Run a reusable Muesly bar"
						ariaLabel="Muesly bars"
						disabled={globalChat.isStreaming}
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
	onRun={(prompt) =>
		pendingBar &&
		executeBar(
			pendingBar,
			addBarInstructions(prompt, pendingAdditionalInstructions),
			pendingOpen ?? (() => {}),
			pendingAdditionalInstructions,
		)}
/>
