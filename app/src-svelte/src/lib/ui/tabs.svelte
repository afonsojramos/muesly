<script lang="ts">
	import { Tabs } from '@ark-ui/svelte/tabs';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	export interface TabItem {
		value: string;
		label: string;
	}

	interface Props {
		tabs: TabItem[];
		value?: string;
		onValueChange?: (value: string) => void;
		class?: string;
		/** One snippet per tab, keyed by tab value. */
		panel: Snippet<[string]>;
	}

	let { tabs, value = $bindable(tabs[0]?.value ?? ''), onValueChange, class: className, panel }: Props =
		$props();
</script>

<Tabs.Root
	value={value}
	onValueChange={(details) => {
		value = details.value;
		onValueChange?.(details.value);
	}}
	class={cn('w-full', className)}
>
	<Tabs.List class="relative inline-flex items-center gap-1 border-b border-border">
		{#each tabs as tab (tab.value)}
			<Tabs.Trigger
				value={tab.value}
				class="relative px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[selected]:text-foreground"
			>
				{tab.label}
			</Tabs.Trigger>
		{/each}
		<Tabs.Indicator class="absolute bottom-0 h-0.5 bg-accent transition-all" />
	</Tabs.List>
	{#each tabs as tab (tab.value)}
		<Tabs.Content value={tab.value} class="mt-4 focus:outline-none">
			{@render panel(tab.value)}
		</Tabs.Content>
	{/each}
</Tabs.Root>
