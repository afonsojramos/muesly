<script lang="ts">
	import { Switch } from '@ark-ui/svelte/switch';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		checked?: boolean;
		disabled?: boolean;
		name?: string;
		class?: string;
		label?: Snippet;
		onCheckedChange?: (checked: boolean) => void;
	}

	let {
		checked = $bindable(false),
		disabled = false,
		name,
		class: className,
		label,
		onCheckedChange
	}: Props = $props();
</script>

<Switch.Root
	{name}
	{disabled}
	checked={checked}
	onCheckedChange={(details) => {
		checked = details.checked;
		onCheckedChange?.(details.checked);
	}}
	class={cn('inline-flex items-center gap-2', className)}
>
	<Switch.Control
		class="peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors data-[state=checked]:bg-accent data-[state=unchecked]:bg-input data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
	>
		<Switch.Thumb
			class="pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
		/>
	</Switch.Control>
	{#if label}
		<Switch.Label class="text-sm font-medium leading-none">{@render label()}</Switch.Label>
	{/if}
	<Switch.HiddenInput />
</Switch.Root>
