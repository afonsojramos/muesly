<script lang="ts" generics="T extends { label: string; value: string; disabled?: boolean }">
	import { Combobox, createListCollection } from '@ark-ui/svelte/combobox';
	import { Portal } from '@ark-ui/svelte/portal';
	import { Check, ChevronsUpDown } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	interface Props {
		items: T[];
		value?: string[];
		placeholder?: string;
		label?: string;
		disabled?: boolean;
		class?: string;
		onValueChange?: (value: string[]) => void;
		onInputValueChange?: (inputValue: string) => void;
	}

	let {
		items,
		value = $bindable<string[]>([]),
		placeholder = 'Search…',
		label,
		disabled = false,
		class: className,
		onValueChange,
		onInputValueChange
	}: Props = $props();

	// Local filter over the provided items. Callers can either pre-filter via
	// `onInputValueChange` (server/async) or rely on this client-side filter.
	let query = $state('');
	const filtered = $derived(
		query.trim() === ''
			? items
			: items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
	);
	const collection = $derived(createListCollection({ items: filtered }));
</script>

<Combobox.Root
	collection={collection}
	{disabled}
	value={value}
	class={cn('w-full', className)}
	onValueChange={(details) => {
		value = details.value;
		onValueChange?.(details.value);
	}}
	onInputValueChange={(details) => {
		query = details.inputValue;
		onInputValueChange?.(details.inputValue);
	}}
>
	{#if label}
		<Combobox.Label class="mb-1 block text-sm font-medium">{label}</Combobox.Label>
	{/if}
	<Combobox.Control class="relative">
		<Combobox.Input
			{placeholder}
			class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pr-9 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
		/>
		<Combobox.Trigger class="absolute inset-y-0 right-0 flex items-center pr-2">
			<ChevronsUpDown class="size-4 opacity-50" />
		</Combobox.Trigger>
	</Combobox.Control>
	<Portal>
		<Combobox.Positioner>
			<Combobox.Content
				class="z-50 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md focus:outline-none"
			>
				{#each collection.items as item (item.value)}
					<Combobox.Item
						{item}
						class="relative flex cursor-pointer select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-secondary data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
					>
						<Combobox.ItemText>{item.label}</Combobox.ItemText>
						<Combobox.ItemIndicator><Check class="size-4" /></Combobox.ItemIndicator>
					</Combobox.Item>
				{:else}
					<div class="px-2 py-1.5 text-sm text-muted-foreground">No results</div>
				{/each}
			</Combobox.Content>
		</Combobox.Positioner>
	</Portal>
</Combobox.Root>
