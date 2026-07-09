<script lang="ts">
	import { ArrowUp, ChevronDown, MessagesSquare, Sparkles, Square, X } from '@lucide/svelte';

	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Textarea } from '$lib/components/ui/textarea';
	import { chat } from '$lib/stores/chat.svelte';

	import { RECIPES, type Recipe } from './recipes';

	let recipesOpen = $state(false);
	let panelOpen = $state(true);

	const hasMessages = $derived(chat.messages.length > 0);

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
</script>

<div class="flex w-[min(42rem,calc(100vw-3rem))] flex-col gap-2">
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
						onclick={() => chat.clear()}
						aria-label="Clear conversation"
					>
						<X data-icon />
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
			<ScrollArea class="min-h-0 flex-1">
				<div class="flex flex-col gap-3 p-4">
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
			</ScrollArea>
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

		<Popover.Root bind:open={recipesOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon"
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
			placeholder="Ask anything about this meeting…"
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
