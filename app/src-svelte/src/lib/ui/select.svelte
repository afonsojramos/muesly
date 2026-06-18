<script lang="ts" generics="T extends { label: string; value: string; disabled?: boolean }">
	import { Select, createListCollection } from '@ark-ui/svelte/select';
	import { Portal } from '@ark-ui/svelte/portal';
	import { Check, ChevronDown } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	interface Props {
		items: T[];
		value?: string[];
		placeholder?: string;
		label?: string;
		multiple?: boolean;
		disabled?: boolean;
		name?: string;
		class?: string;
		onValueChange?: (value: string[]) => void;
	}

	let {
		items,
		value = $bindable<string[]>([]),
		placeholder = 'Select…',
		label,
		multiple = false,
		disabled = false,
		name,
		class: className,
		onValueChange
	}: Props = $props();

	const collection = $derived(createListCollection({ items }));
</script>

<Select.Root
	collection={collection}
	{multiple}
	{disabled}
	{name}
	value={value}
	onValueChange={(details) => {
		value = details.value;
		onValueChange?.(details.value);
	}}
	class={cn('w-full', className)}
>
	{#if label}
		<Select.Label class="mb-1 block text-sm font-medium">{label}</Select.Label>
	{/if}
	<Select.Control>
		<Select.Trigger
			class="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
		>
			<Select.ValueText {placeholder} />
			<Select.Indicator><ChevronDown class="size-4 opacity-50" /></Select.Indicator>
		</Select.Trigger>
	</Select.Control>
	<Portal>
		<Select.Positioner>
			<Select.Content
				class="z-50 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md focus:outline-none"
			>
				{#each collection.items as item (item.value)}
					<Select.Item
						{item}
						class="relative flex cursor-pointer select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-secondary data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
					>
						<Select.ItemText>{item.label}</Select.ItemText>
						<Select.ItemIndicator><Check class="size-4" /></Select.ItemIndicator>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Positioner>
	</Portal>
	<Select.HiddenSelect />
</Select.Root>
