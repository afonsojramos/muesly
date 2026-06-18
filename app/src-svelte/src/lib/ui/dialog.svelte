<script lang="ts">
	import { Dialog } from '@ark-ui/svelte/dialog';
	import { Portal } from '@ark-ui/svelte/portal';
	import { X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		/** Accessible title — rendered visually unless `hideTitle` is set. */
		title?: string;
		/** Hide the title visually but keep it for screen readers. */
		hideTitle?: boolean;
		description?: string;
		trigger?: Snippet;
		children: Snippet;
		footer?: Snippet;
		class?: string;
		showClose?: boolean;
	}

	let {
		open = $bindable(false),
		onOpenChange,
		title,
		hideTitle = false,
		description,
		trigger,
		children,
		footer,
		class: className,
		showClose = true
	}: Props = $props();
</script>

<Dialog.Root
	open={open}
	onOpenChange={(details) => {
		open = details.open;
		onOpenChange?.(details.open);
	}}
>
	{#if trigger}
		<Dialog.Trigger class="inline-flex" tabindex={-1}>{@render trigger()}</Dialog.Trigger>
	{/if}
	<Portal>
		<Dialog.Backdrop class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
		<Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
			<Dialog.Content
				class={cn(
					'relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border bg-card p-6 shadow-lg focus:outline-none',
					className
				)}
			>
				{#if title}
					<Dialog.Title class={hideTitle ? 'sr-only' : 'flex-shrink-0 text-lg font-semibold'}>
						{title}
					</Dialog.Title>
				{/if}
				{#if description}
					<Dialog.Description class="mt-1 flex-shrink-0 text-sm text-muted-foreground">
						{description}
					</Dialog.Description>
				{/if}

				<!-- min-h-0 + overflow keeps tall content scrolling inside the card
				     instead of bleeding past its fixed/max height. -->
				<!-- -mx/px keep layout width while giving focus rings 8px of paint
				     room inside the scrollport so they don't get side-clipped. -->
				<div
					class={cn(
						'-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1',
						(title || description) && 'mt-4'
					)}
				>
					{@render children()}
				</div>

				{#if footer}
					<div class="mt-6 flex flex-shrink-0 justify-end gap-2">{@render footer()}</div>
				{/if}

				{#if showClose}
					<Dialog.CloseTrigger
						class="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
						aria-label="Close"
					>
						<X class="size-4" />
					</Dialog.CloseTrigger>
				{/if}
			</Dialog.Content>
		</Dialog.Positioner>
	</Portal>
</Dialog.Root>
