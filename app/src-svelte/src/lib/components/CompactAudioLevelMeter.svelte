<script lang="ts">
	import { cn } from '$lib/utils';

	interface Props {
		rmsLevel: number;
		isActive: boolean;
		class?: string;
	}

	let { rmsLevel, isActive, class: className = '' }: Props = $props();

	const rmsPercent = $derived.by(() => {
		const n = Math.max(0, Math.min(1, rmsLevel));
		const log = n > 0 ? Math.log10(n * 9 + 1) : 0;
		return Math.round(log * 100);
	});

	const color = $derived(
		rmsPercent / 100 < 0.3
			? 'bg-success'
			: rmsPercent / 100 < 0.7
				? 'bg-warning'
				: 'bg-destructive',
	);
</script>

<div class={cn('flex items-center gap-1', className)}>
	<div
		class={cn('size-1.5 rounded-full', isActive ? 'bg-success' : 'bg-muted-foreground/30')}
	></div>
	<div class="h-1.5 w-8 overflow-hidden rounded-sm bg-secondary">
		<div
			class={cn('h-full transition-all duration-150', color)}
			style={`width: ${rmsPercent}%`}
		></div>
	</div>
</div>
