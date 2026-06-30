<script lang="ts">
	import { cn } from '$lib/utils';

	interface Props {
		rmsLevel: number;
		peakLevel: number;
		isActive: boolean;
		deviceName: string;
		class?: string;
		size?: 'small' | 'medium' | 'large';
	}

	let {
		rmsLevel,
		peakLevel,
		isActive,
		deviceName,
		class: className = '',
		size = 'medium'
	}: Props = $props();

	const logScale = (v: number): number => {
		const n = Math.max(0, Math.min(1, v));
		return n > 0 ? Math.log10(n * 9 + 1) : 0;
	};

	const logRms = $derived(logScale(rmsLevel));
	const logPeak = $derived(logScale(peakLevel));
	const rmsPercent = $derived(Math.round(logRms * 100));
	const peakPercent = $derived(Math.round(logPeak * 100));

	const levelColor = (level: number): string =>
		level < 0.3 ? 'bg-success' : level < 0.7 ? 'bg-warning' : 'bg-destructive';

	const sizeClasses = {
		small: { container: 'h-2', text: 'text-xs', meter: 'h-1.5' },
		medium: { container: 'h-3', text: 'text-sm', meter: 'h-2' },
		large: { container: 'h-4', text: 'text-base', meter: 'h-3' }
	};
	const sizes = $derived(sizeClasses[size]);
</script>

<div class={cn('flex items-center gap-2', className)}>
	<div
		class={cn(
			'size-2 rounded-full',
			isActive ? 'animate-pulse bg-success' : 'bg-muted-foreground/30'
		)}
		title={`${deviceName} - ${isActive ? 'Active' : 'Inactive'}`}
	></div>

	<div class={cn('relative flex-1', sizes.container)}>
		<div class="size-full overflow-hidden rounded-sm bg-secondary">
			<div
				class={cn(sizes.meter, levelColor(logRms), 'rounded-sm transition-all duration-150 ease-out')}
				style={`width: ${rmsPercent}%`}
			></div>
			{#if peakPercent > rmsPercent}
				<div
					class={cn('absolute bottom-0 top-0 w-0.5 transition-all duration-75', levelColor(logPeak))}
					style={`left: ${peakPercent}%`}
				></div>
			{/if}
		</div>
	</div>

	<div class={cn('min-w-[3rem] text-right font-mono text-muted-foreground', sizes.text)}>
		{rmsPercent}%
	</div>
</div>
