<script lang="ts">
	import { Progress } from '@ark-ui/svelte/progress';
	import { cn } from '$lib/utils';

	interface Props {
		value?: number | null;
		max?: number;
		class?: string;
	}

	let { value = 0, max = 100, class: className }: Props = $props();
</script>

<Progress.Root {value} {max} class={cn('w-full', className)}>
	<Progress.Track class="h-2 w-full overflow-hidden rounded-full bg-secondary">
		<Progress.Range class="h-full bg-accent transition-all" />
	</Progress.Track>
</Progress.Root>
