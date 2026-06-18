<script lang="ts">
	import { Tooltip } from '@ark-ui/svelte/tooltip';
	import { Portal } from '@ark-ui/svelte/portal';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		trigger: Snippet;
		/** Rich content. For plain text prefer `label` (+ optional `shortcut`). */
		content?: Snippet;
		/** Simple text label, used when no `content` snippet is given. */
		label?: string;
		/** Keyboard shortcut hint rendered after the label (e.g. "⌘S"). */
		shortcut?: string;
		class?: string;
		openDelay?: number;
		closeDelay?: number;
		/** Let Escape close the tooltip. Disable when a parent owns Escape (e.g. roving focus). */
		closeOnEscape?: boolean;
	}

	let {
		trigger,
		content,
		label,
		shortcut,
		class: className,
		openDelay = 300,
		closeDelay = 100,
		closeOnEscape = true
	}: Props = $props();
</script>

<Tooltip.Root {openDelay} {closeDelay} {closeOnEscape}>
	<Tooltip.Trigger class="inline-flex" tabindex={-1}>{@render trigger()}</Tooltip.Trigger>
	<Portal>
		<Tooltip.Positioner>
			<Tooltip.Content
				class={cn(
					'z-50 overflow-hidden rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-md',
					className
				)}
			>
				{#if content}
					{@render content()}
				{:else if label}
					<span class="flex items-center">
						{label}
						{#if shortcut}
							<span class="ml-1.5 tracking-wide opacity-60">{shortcut}</span>
						{/if}
					</span>
				{/if}
			</Tooltip.Content>
		</Tooltip.Positioner>
	</Portal>
</Tooltip.Root>
