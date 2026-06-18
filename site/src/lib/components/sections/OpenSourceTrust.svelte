<script lang="ts">
	import BadgeCheck from '@lucide/svelte/icons/badge-check';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Section from '$lib/ui/Section.svelte';

	const items = [
		{ icon: BadgeCheck, label: 'Open source (MIT)' },
		{ icon: ShieldCheck, label: 'No account required' },
		{ icon: HardDrive, label: 'On-device by default' }
	];
</script>

<Section class="py-6">
	<ul
		class="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm font-medium text-muted-foreground"
	>
		{#each items as item (item.label)}
			<li class="flex items-center gap-2">
				<item.icon class="h-4 w-4 text-accent" aria-hidden="true" />
				{item.label}
			</li>
		{/each}
	</ul>
</Section>
