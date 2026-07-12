<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Trash2 } from '@lucide/svelte';

	import Spinner from '$lib/components/Spinner.svelte';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import { globalChat, type GlobalChatMessage } from '$lib/stores/global-chat.svelte';
	import { bars } from '$lib/stores/bars.svelte';
	import { barIcon, type Bar } from '$lib/bars/catalog';

	import ChatSurface, { type ChatSurfaceMessage } from './ChatSurface.svelte';

	let barsOpen = $state(false);

	onMount(() => {
		void bars.ensureLoaded();
	});

	// The surface passes the shared message shape; the store's messages carry the
	// extra `actions` we render as agent steps.
	function actionsOf(message: ChatSurfaceMessage): GlobalChatMessage['actions'] {
		return (message as GlobalChatMessage).actions ?? [];
	}

	function runBar(bar: Bar, open: () => void): void {
		barsOpen = false;
		open();
		bars.track(bar);
		void globalChat.send(bar.prompt);
	}
</script>

<ChatSurface
	controller={globalChat}
	title="Ask your meetings"
	placeholder="Ask across all your meetings…"
	collapsedPlaceholder="Ask your meetings"
	ariaLabel="Ask across all your meetings"
	emptyLabel="No answer produced."
	overlayActive={barsOpen}
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
					<Command.List>
						<Command.Empty>No bars yet.</Command.Empty>
						<Command.Group heading="Muesly bars">
							{#each bars.forSurface('global') as bar (bar.id)}
								{@const Icon = barIcon(bar.icon)}
								<Command.Item value={bar.title} onSelect={() => runBar(bar, open)}>
									<Icon class="size-4 text-muted-foreground" />
									<span>{bar.title}</span>
								</Command.Item>
							{/each}
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
