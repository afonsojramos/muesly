<script lang="ts">
	import { Smile, X } from '@lucide/svelte';

	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';

	interface Props {
		value: string | null;
		onSelect: (emoji: string | null) => void;
		class?: string;
	}
	let { value, onSelect, class: className }: Props = $props();

	let open = $state(false);

	// A curated set covering common folder/category uses — a lightweight,
	// dependency-free picker (a full Unicode picker would be a heavy dependency).
	const EMOJIS = [
		'💼',
		'📁',
		'🗂️',
		'📋',
		'📌',
		'📎',
		'🗓️',
		'📅',
		'🎯',
		'🚀',
		'💡',
		'🔥',
		'⭐',
		'✅',
		'🏆',
		'📈',
		'📊',
		'💰',
		'🤝',
		'👥',
		'🧑‍💻',
		'🎓',
		'📚',
		'✏️',
		'📝',
		'🧠',
		'🔬',
		'⚙️',
		'🛠️',
		'🐛',
		'🔒',
		'🔑',
		'🌐',
		'💻',
		'📱',
		'☁️',
		'🎨',
		'🎬',
		'📷',
		'🎵',
		'🎤',
		'🎧',
		'🎉',
		'🍕',
		'☕',
		'❤️',
		'💙',
		'💚',
		'💜',
		'🧡',
		'💛',
		'🖤',
		'🌱',
		'🌟',
		'🌈',
		'☀️',
		'🌙',
		'⚡',
		'❄️',
		'🌊',
		'🏠',
		'🧭',
		'🔴',
		'🟠',
		'🟡',
		'🟢',
		'🔵',
		'🟣',
		'1️⃣',
		'2️⃣',
		'3️⃣',
		'🅰️',
	];

	function pick(emoji: string): void {
		onSelect(emoji);
		open = false;
	}
	function clear(): void {
		onSelect(null);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				type="button"
				class={cn('h-9 w-14 text-lg', className)}
				aria-label="Choose folder emoji"
			>
				{#if value}
					{value}
				{:else}
					<Smile class="size-4 text-muted-foreground" />
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-64 p-2">
		<div class="grid grid-cols-8 gap-0.5">
			{#each EMOJIS as emoji (emoji)}
				<button
					type="button"
					onclick={() => pick(emoji)}
					class={cn(
						'flex size-7 items-center justify-center rounded text-lg transition-colors hover:bg-secondary',
						value === emoji && 'bg-secondary',
					)}
					aria-label={`Emoji ${emoji}`}
				>
					{emoji}
				</button>
			{/each}
		</div>
		<div class="mt-1 border-t border-border pt-1">
			<button
				type="button"
				onclick={clear}
				class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary"
			>
				<X class="size-3.5" />
				No emoji
			</button>
		</div>
	</Popover.Content>
</Popover.Root>
