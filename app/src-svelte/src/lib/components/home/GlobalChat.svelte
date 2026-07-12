<script lang="ts">
	import { ArrowUp, Check, Loader, Sparkles, Square, X } from '@lucide/svelte';

	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { globalChat } from '$lib/stores/global-chat.svelte';

	const hasMessages = $derived(globalChat.messages.length > 0);

	let viewportRef = $state<HTMLElement | null>(null);

	// Keep the newest content in view as steps land and tokens stream.
	const lastSignal = $derived(
		`${globalChat.messages.at(-1)?.content.length ?? 0}:${globalChat.messages.at(-1)?.actions.length ?? 0}`,
	);
	$effect(() => {
		void lastSignal;
		viewportRef?.scrollTo({ top: viewportRef.scrollHeight });
	});

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void globalChat.send();
		}
	}
</script>

<section class="mb-8">
	<div
		class="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_6px_rgb(0,0,0,0.06)]"
	>
		<div class="flex items-center justify-between px-4 pb-1 pt-3">
			<div class="flex items-center gap-2">
				<Sparkles class="size-4 text-brand" />
				<span class="text-sm font-medium">Ask your meetings</span>
			</div>
			{#if hasMessages && !globalChat.isStreaming}
				<Button
					variant="ghost"
					size="icon-sm"
					class="text-muted-foreground"
					onclick={() => globalChat.clear()}
					aria-label="Clear conversation"
				>
					<X data-icon />
				</Button>
			{/if}
		</div>

		{#if hasMessages}
			<div bind:this={viewportRef} class="max-h-[24rem] min-h-0 overflow-y-auto">
				<div class="flex flex-col gap-3 px-4 py-3" aria-live="polite" aria-atomic="false">
					{#each globalChat.messages as message (message.id)}
						{#if message.role === 'user'}
							<div class="flex justify-end">
								<div
									class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground"
								>
									{message.content}
								</div>
							</div>
						{:else}
							<div class="flex flex-col gap-1.5">
								{#if message.actions.length > 0}
									<!-- The agent's visible steps: search/read progress à la
									     "Searching…" chips, checked off as each tool finishes. -->
									<div class="flex flex-col gap-1 px-1">
										{#each message.actions as action (action.id)}
											<div class="flex items-center gap-2 text-xs text-muted-foreground">
												{#if action.done}
													<Check class="size-3.5 shrink-0 text-brand" />
												{:else}
													<Loader class="size-3.5 shrink-0 animate-spin" />
												{/if}
												<span class="truncate">{action.label}</span>
												{#if action.detail}
													<span class="shrink-0 text-muted-foreground/60">· {action.detail}</span>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
								{#if message.content || !globalChat.isStreaming}
									<div class="flex justify-start">
										<div
											class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3 py-2 text-sm text-secondary-foreground"
										>
											{#if message.content}
												{message.content}
											{:else}
												<span class="text-muted-foreground">No answer produced.</span>
											{/if}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		<div class={cn('flex items-center gap-1.5 px-3 pb-3', hasMessages ? 'pt-1' : 'pt-2')}>
			<Textarea
				bind:value={globalChat.draft}
				onkeydown={handleKeydown}
				placeholder="Ask across all your meetings…"
				aria-label="Ask across all your meetings"
				rows={1}
				class="max-h-32 min-h-0 flex-1 resize-none border-0 bg-transparent py-2 shadow-none focus-visible:ring-0"
			/>
			{#if globalChat.isStreaming}
				<Button
					variant="secondary"
					size="icon"
					class="shrink-0 rounded-full"
					onclick={() => globalChat.stop()}
					aria-label="Stop generating"
				>
					<Square data-icon />
				</Button>
			{:else}
				<Button
					size="icon"
					class="shrink-0 rounded-full"
					disabled={!globalChat.draft.trim()}
					onclick={() => void globalChat.send()}
					aria-label="Ask"
				>
					<ArrowUp data-icon />
				</Button>
			{/if}
		</div>
	</div>
</section>
