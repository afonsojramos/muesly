<script lang="ts" module>
	import type { Component } from 'svelte';
	import type { StreamOutcome } from '$lib/chat/stream';

	export interface ChatSurfaceMessage {
		id: string;
		role: 'user' | 'assistant';
		content: string;
		barId?: string;
		barTitle?: string;
		barPrompt?: string;
		barContext?: string;
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
		streamOutcome: StreamOutcome;
		send(text?: string): void | Promise<void>;
		rerun?(message: ChatSurfaceMessage): void;
		stop(): void;
	}

	export interface ChatSlashCommand {
		id: string;
		slug: string;
		label: string;
		description: string;
		icon: Component;
		run: (open: () => void, additionalInstructions?: string) => void;
	}
</script>

<script lang="ts">
	import {
		ArrowUp,
		Check,
		ChevronDown,
		Copy,
		MessagesSquare,
		NotebookPen,
		RotateCcw,
		Square,
	} from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	import { cn } from '$lib/utils';
	import { getStreamAnnouncement } from '$lib/chat/stream';
	import { parseBarCommandDraft } from '$lib/bars/execution';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import MarkdownContent from '$lib/components/MarkdownContent.svelte';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import { ResponseInsertionGuard } from '$lib/notes/insertion';
	import ChatRailButton from './ChatRailButton.svelte';

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
		/** Controls rendered in their own compact pill beside the input. */
		detachedRail?: Snippet;
		/** Extra content above an assistant bubble (the agent's tool steps). */
		messageLeading?: Snippet<[ChatSurfaceMessage]>;
		/** True while any wrapper-owned overlay (popover/dialog) is open. */
		overlayActive?: boolean;
		/** Meeting-only transcript navigation. Omit for global chat. */
		onTimestampClick?: (seconds: number) => void;
		/** Meeting-only action for adding an assistant response to notes. */
		onInsertIntoNotes?: (message: ChatSurfaceMessage) => void | Promise<void>;
		/** Commands offered when the draft starts with `/`. */
		slashCommands?: ChatSlashCommand[];
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
		detachedRail,
		messageLeading,
		overlayActive = false,
		onTimestampClick,
		onInsertIntoNotes,
		slashCommands = [],
		open = $bindable(true),
	}: Props = $props();

	let rootEl = $state<HTMLElement | null>(null);
	let viewportRef = $state<HTMLElement | null>(null);
	let copiedMessageId = $state<string | null>(null);
	let insertionVersion = $state(0);
	const insertionGuard = new ResponseInsertionGuard();
	let activeSlashIndex = $state(0);
	let slashDismissed = $state(false);
	const componentId = $props.id();
	const slashListboxId = `${componentId}-bar-commands`;

	const hasMessages = $derived(controller.messages.length > 0);
	const streamAnnouncement = $derived(getStreamAnnouncement(controller.streamOutcome));
	const slashQuery = $derived.by(() => {
		const draft = controller.draft.trimStart();
		if (!draft.startsWith('/') || draft.includes('\n')) return null;
		const query = draft.slice(1);
		// Once the command token is complete, the rest belongs to the user's
		// additional instructions and the discovery menu should get out of the way.
		if (/\s/.test(query)) return null;
		return query.toLowerCase();
	});
	const matchingSlashCommands = $derived.by(() => {
		if (slashQuery === null) return [];
		return (
			slashCommands
				.filter((command) =>
					`${command.slug} ${command.label} ${command.description}`
						.toLowerCase()
						.includes(slashQuery),
				)
				// Keep every keyboard-reachable option visible while focus remains in
				// the textarea. Typing another character narrows larger catalogs quickly.
				.slice(0, 5)
		);
	});
	const slashMenuOpen = $derived(
		!slashDismissed && !controller.isStreaming && matchingSlashCommands.length > 0,
	);

	$effect(() => {
		void slashQuery;
		activeSlashIndex = 0;
		slashDismissed = false;
	});

	// Keep the newest content in view as tokens stream / turns are added — but only
	// when the user is already near the bottom, so scrolling up to read earlier
	// messages isn't yanked back to the bottom on every streamed token.
	let atBottom = $state(true);
	function onViewportScroll(): void {
		if (!viewportRef) return;
		atBottom = viewportRef.scrollHeight - viewportRef.scrollTop - viewportRef.clientHeight < 80;
	}
	const lastContent = $derived(controller.messages.at(-1)?.content ?? '');
	$effect(() => {
		// Track both signals.
		void lastContent;
		void controller.messages.length;
		if (atBottom) viewportRef?.scrollTo({ top: viewportRef.scrollHeight });
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
		if (slashMenuOpen && !event.isComposing) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				activeSlashIndex = (activeSlashIndex + 1) % matchingSlashCommands.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				activeSlashIndex =
					(activeSlashIndex - 1 + matchingSlashCommands.length) % matchingSlashCommands.length;
				return;
			}
			if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
				event.preventDefault();
				completeSlashCommand(matchingSlashCommands[activeSlashIndex]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				slashDismissed = true;
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void submit();
		}
	}

	async function submit(): Promise<void> {
		if (controller.isStreaming || !controller.draft.trim()) return;
		const parsedCommand = parseBarCommandDraft(controller.draft);
		if (parsedCommand) {
			const command = slashCommands.find((candidate) => candidate.slug === parsedCommand.slug);
			if (command) {
				controller.draft = '';
				command.run(() => (open = true), parsedCommand.additionalInstructions);
				return;
			}
		}
		open = true;
		await controller.send();
	}

	function completeSlashCommand(command: ChatSlashCommand | undefined): void {
		if (!command) return;
		controller.draft = `/${command.slug} `;
	}

	async function copyMessage(message: ChatSurfaceMessage): Promise<void> {
		await navigator.clipboard.writeText(message.content);
		copiedMessageId = message.id;
		setTimeout(() => {
			if (copiedMessageId === message.id) copiedMessageId = null;
		}, 1500);
	}

	async function insertIntoNotes(message: ChatSurfaceMessage): Promise<void> {
		if (!onInsertIntoNotes) return;
		insertionVersion += 1;
		try {
			await insertionGuard.run(message.id, () => Promise.resolve(onInsertIntoNotes(message)));
		} finally {
			insertionVersion += 1;
		}
	}

	function insertionDisabled(messageId: string, _version: number): boolean {
		return insertionGuard.isDisabled(messageId);
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
			<div
				bind:this={viewportRef}
				onscroll={onViewportScroll}
				class="min-h-0 flex-1 overflow-y-auto"
			>
				<div class="flex flex-col gap-3 p-4">
					{#each controller.messages as message (message.id)}
						<div class="group/message flex flex-col gap-1.5">
							{#if message.role === 'assistant'}
								{@render messageLeading?.(message)}
							{/if}
							{#if !(hideEmptyBubbleWhileStreaming && message.role === 'assistant' && !message.content && controller.isStreaming)}
								<div
									class={cn(
										'flex items-start',
										message.role === 'user' ? 'justify-end' : 'justify-start',
									)}
								>
									<div
										class={cn(
											'select-text rounded-2xl px-3 py-2 text-sm',
											message.role === 'user' && 'whitespace-pre-wrap',
											message.role === 'user'
												? 'max-w-[85%] bg-primary text-primary-foreground'
												: 'max-w-[75%] bg-secondary text-secondary-foreground',
										)}
									>
										{#if message.content}
											{#if message.role === 'user' && message.barTitle}
												<div class="flex flex-col gap-0.5">
													<span class="flex items-center gap-1.5 font-medium">
														<MueslyBar class="size-3.5 shrink-0" />
														{message.barTitle}
													</span>
													{#if message.barContext}
														<span class="font-normal opacity-80">{message.barContext}</span>
													{/if}
												</div>
											{:else}
												<MarkdownContent value={message.content} {onTimestampClick} />
											{/if}
										{:else if controller.isStreaming}
											<span class="text-muted-foreground">{thinkingLabel}</span>
										{:else}
											<span class="text-muted-foreground">{emptyLabel}</span>
										{/if}
									</div>
									{#if message.role === 'assistant' && message.content}
										<div
											class="flex items-center gap-1 px-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/message:opacity-100 sm:focus-within:opacity-100"
										>
											<Button
												variant="ghost"
												size="icon"
												class="size-10 text-muted-foreground"
												onclick={() => void copyMessage(message)}
												aria-label="Copy response"
											>
												{#if copiedMessageId === message.id}<Check data-icon />{:else}<Copy
														data-icon
													/>{/if}
											</Button>
											{#if onInsertIntoNotes}
												{@const insertDisabled = insertionDisabled(message.id, insertionVersion)}
												<Button
													variant="ghost"
													size="icon"
													class="size-10 text-muted-foreground"
													disabled={insertDisabled}
													onclick={() => void insertIntoNotes(message)}
													aria-label={insertionGuard.isPending(message.id)
														? 'Inserting response into notes'
														: 'Insert response into notes'}
												>
													<NotebookPen data-icon />
												</Button>
											{/if}
											{#if message.barPrompt && controller.rerun}
												<Button
													variant="ghost"
													size="icon"
													class="size-10 text-muted-foreground"
													onclick={() => controller.rerun?.(message)}
													aria-label="Run bar again"
												>
													<RotateCcw data-icon />
												</Button>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}
	<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
		{streamAnnouncement}
	</div>

	<!-- items-center keeps the icon rail, input, and send button on one vertical
	     axis in every state (a grown multiline draft included) — never the
	     bottom-pinned look. -->
	<div class="flex items-center gap-2">
		{#if detachedRail}
			<div
				class="flex shrink-0 self-stretch items-center gap-1 rounded-[1.75rem] border border-border bg-card p-1.5 shadow-[0_2px_12px_rgb(0,0,0,0.1)]"
			>
				{@render detachedRail()}
			</div>
		{/if}

		<div
			class="relative flex min-w-0 flex-1 items-center gap-1.5 rounded-[1.75rem] border border-border bg-card py-1.5 pl-1.5 pr-2 shadow-[0_2px_12px_rgb(0,0,0,0.1)]"
		>
			{#if slashMenuOpen}
				<div
					id={slashListboxId}
					class="absolute inset-x-2 bottom-full z-50 mb-2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_8px_30px_rgb(0,0,0,0.14)]"
					role="listbox"
					aria-label="Muesly bar commands"
				>
					<div class="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
						Muesly bars
					</div>
					<div class="max-h-72 overflow-y-auto p-1.5">
						{#each matchingSlashCommands as command, index (command.id)}
							{@const Icon = command.icon}
							<button
								id={`${slashListboxId}-${index}`}
								type="button"
								role="option"
								aria-selected={index === activeSlashIndex}
								class={cn(
									'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
									index === activeSlashIndex
										? 'bg-accent text-accent-foreground'
										: 'hover:bg-accent/60',
								)}
								onpointerenter={() => (activeSlashIndex = index)}
								onmousedown={(event) => event.preventDefault()}
								onclick={() => completeSlashCommand(command)}
							>
								<Icon class="size-4 shrink-0 text-muted-foreground" />
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{command.label}</span>
									<span class="block truncate text-xs text-muted-foreground"
										>{command.description}</span
									>
								</span>
								<code class="shrink-0 text-xs text-muted-foreground">/{command.slug}</code>
							</button>
						{/each}
					</div>
				</div>
			{/if}
			{#if hasMessages && !open}
				<ChatRailButton tooltip="Show conversation" onclick={() => (open = true)}>
					<MessagesSquare data-icon />
				</ChatRailButton>
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
				role="combobox"
				aria-autocomplete="list"
				aria-haspopup="listbox"
				aria-expanded={slashMenuOpen}
				aria-controls={slashMenuOpen ? slashListboxId : undefined}
				aria-activedescendant={slashMenuOpen ? `${slashListboxId}-${activeSlashIndex}` : undefined}
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
</div>
