<script lang="ts">
	import { Check, Sparkles, Trash2 } from '@lucide/svelte';

	import Spinner from '$lib/components/Spinner.svelte';
	import { Button } from '$lib/components/ui/button';
	import { globalChat, type GlobalChatMessage } from '$lib/stores/global-chat.svelte';

	import ChatSurface, { type ChatSurfaceMessage } from './ChatSurface.svelte';

	// The surface passes the shared message shape; the store's messages carry the
	// extra `actions` we render as agent steps.
	function actionsOf(message: ChatSurfaceMessage): GlobalChatMessage['actions'] {
		return (message as GlobalChatMessage).actions ?? [];
	}
</script>

<ChatSurface
	controller={globalChat}
	title="Ask your meetings"
	placeholder="Ask across all your meetings…"
	collapsedPlaceholder="Ask your meetings"
	ariaLabel="Ask across all your meetings"
	emptyLabel="No answer produced."
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

	{#snippet rail()}
		<div class="flex size-9 shrink-0 items-center justify-center">
			<Sparkles class="size-4 text-brand" />
		</div>
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
