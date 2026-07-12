<script lang="ts" module>
	export interface ChatSurfaceMessage {
		id: string;
		role: 'user' | 'assistant';
		content: string;
	}

	/**
	 * The minimal contract both chat stores satisfy (per-meeting `chat` and the
	 * agentic `globalChat`). ChatSurface renders the shared pill + panel shell and
	 * drives the controller; wrappers add their store-specific chrome via snippets.
	 */
	export interface ChatSurfaceController {
		messages: ChatSurfaceMessage[];
		draft: string;
		isStreaming: boolean;
		send(text?: string): void | Promise<void>;
		stop(): void;
	}
</script>

<script lang="ts">
	import { ArrowUp, ChevronDown, MessagesSquare, Square } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';

	interface Props {
		controller: ChatSurfaceController;
		/** Panel header label. */
		title: string;
		/** Textarea placeholder when the panel is open (or there is no history). */
		placeholder: string;
		/** Textarea placeholder in the collapsed pill once a thread exists. */
		collapsedPlaceholder?: string;
		ariaLabel?: string;
		/** Empty assistant bubble copy while still streaming. */
		thinkingLabel?: string;
		/** Empty assistant bubble copy once streaming has ended. */
		emptyLabel?: string;
		/** Hide the assistant bubble while it is empty and streaming (steps still show). */
		hideEmptyBubbleWhileStreaming?: boolean;
		/** Extra buttons in the panel header, before the collapse control. */
		headerActions?: Snippet;
		/** Leading buttons in the input pill (bars, recents, …). */
		rail?: Snippet<[{ open: () => void }]>;
		/** Extra content above an assistant bubble (the agent's tool steps). */
		messageLeading?: Snippet<[ChatSurfaceMessage]>;
		/** True while any wrapper-owned overlay (popover/dialog) is open. */
		overlayActive?: boolean;
		/** Whether the message panel is expanded. Bindable so wrappers can control
		 *  it (e.g. collapse per meeting). Defaults open for the global chat. */
		open?: boolean;
	}

	let {
		controller,
		title,
		placeholder,
		collapsedPlaceholder = placeholder,
		ariaLabel = placeholder,
		thinkingLabel = 'Thinking…',
		emptyLabel = thinkingLabel,
		hideEmptyBubbleWhileStreaming = false,
		headerActions,
		rail,
		messageLeading,
		overlayActive = false,
		open = $bindable(true),
	}: Props = $props();

	let rootEl = $state<HTMLElement | null>(null);
	let viewportRef = $state<HTMLElement | null>(null);

	const hasMessages = $derived(controller.messages.length > 0);

	// Keep the newest content in view as tokens stream / turns are added.
	const lastContent = $derived(controller.messages.at(-1)?.content ?? '');
	$effect(() => {
		// Track both signals.
		void lastContent;
		void controller.messages.length;
		viewportRef?.scrollTo({ top: viewportRef.scrollHeight });
	});

	// Clicking outside the bar collapses the panel (it never deletes anything).
	// Portaled layers (popovers, dialogs) render outside the root, so clicks
	// inside them must not count as "outside".
	function onDocumentPointerDown(event: PointerEvent): void {
		if (!open || !hasMessages) return;
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
		open = false;
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		// Esc collapses the panel. Leave it to portaled layers when one is open —
		// including the same keypress that just closed one (bits-ui updates state
		// before this window-level handler runs, so also honor defaultPrevented).
		if (event.key !== 'Escape' || event.defaultPrevented || overlayActive) return;
		if (open && hasMessages) open = false;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void submit();
		}
	}

	async function submit(): Promise<void> {
		if (controller.isStreaming || !controller.draft.trim()) return;
		open = true;
		await controller.send();
	}
</script>

<svelte:document onpointerdown={onDocumentPointerDown} />
<svelte:window onkeydown={onWindowKeydown} />

<div bind:this={rootEl} class="flex w-[min(42rem,calc(100vw-3rem))] flex-col gap-2">
	{#if hasMessages && open}
		<div
			class="flex max-h-[min(60vh,32rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_12px_rgb(0,0,0,0.1)]"
		>
			<div class="flex items-center justify-between border-b border-border px-4 py-2">
				<span class="text-sm font-medium">{title}</span>
				<div class="flex items-center gap-1">
					{@render headerActions?.()}
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => (open = false)}
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
					{#each controller.messages as message (message.id)}
						<div class="flex flex-col gap-1.5">
							{#if message.role === 'assistant'}
								{@render messageLeading?.(message)}
							{/if}
							{#if !(hideEmptyBubbleWhileStreaming && message.role === 'assistant' && !message.content && controller.isStreaming)}
								<div class={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
									<div
										class={cn(
											'max-w-[85%] select-text whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm',
											message.role === 'user'
												? 'bg-primary text-primary-foreground'
												: 'bg-secondary text-secondary-foreground',
										)}
									>
										{#if message.content}
											{message.content}
										{:else if controller.isStreaming}
											<span class="text-muted-foreground">{thinkingLabel}</span>
										{:else}
											<span class="text-muted-foreground">{emptyLabel}</span>
										{/if}
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<!-- items-center keeps the icon rail, input, and send button on one vertical
	     axis in every state (a grown multiline draft included) — never the
	     bottom-pinned look. -->
	<div
		class="flex items-center gap-1.5 rounded-[1.75rem] border border-border bg-card py-1.5 pl-1.5 pr-2 shadow-[0_2px_12px_rgb(0,0,0,0.1)]"
	>
		{#if hasMessages && !open}
			<Button
				variant="ghost"
				size="icon"
				class="shrink-0 rounded-full text-muted-foreground"
				onclick={() => (open = true)}
				aria-label="Show conversation"
			>
				<MessagesSquare data-icon />
			</Button>
		{/if}

		{@render rail?.({ open: () => (open = true) })}

		<Textarea
			bind:value={controller.draft}
			onkeydown={handleKeydown}
			onfocus={() => {
				if (hasMessages) open = true;
			}}
			placeholder={hasMessages && !open ? collapsedPlaceholder : placeholder}
			aria-label={ariaLabel}
			rows={1}
			class="max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent py-2 shadow-none focus-visible:ring-0"
		/>

		{#if controller.isStreaming}
			<Button
				variant="secondary"
				size="icon"
				class="shrink-0 rounded-full"
				onclick={() => controller.stop()}
				aria-label="Stop generating"
			>
				<Square data-icon />
			</Button>
		{:else}
			<Button
				size="icon"
				class="shrink-0 rounded-full"
				disabled={!controller.draft.trim()}
				onclick={submit}
				aria-label="Send"
			>
				<ArrowUp data-icon />
			</Button>
		{/if}
	</div>
</div>
