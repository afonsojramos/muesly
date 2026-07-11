<script lang="ts">
	interface Props {
		progress: number;
		size?: number;
		strokeWidth?: number;
	}

	let { progress, size = 40, strokeWidth = 3 }: Props = $props();

	const radius = $derived((size - strokeWidth) / 2);
	const circumference = $derived(radius * 2 * Math.PI);
	const dashOffset = $derived(circumference - (progress / 100) * circumference);
</script>

<div class="relative inline-flex items-center justify-center">
	<svg width={size} height={size} class="-rotate-90">
		<circle
			cx={size / 2}
			cy={size / 2}
			r={radius}
			stroke="var(--color-border)"
			stroke-width={strokeWidth}
			fill="transparent"
		/>
		<circle
			cx={size / 2}
			cy={size / 2}
			r={radius}
			stroke="var(--color-brand)"
			stroke-width={strokeWidth}
			stroke-dasharray={circumference}
			stroke-dashoffset={dashOffset}
			stroke-linecap="round"
			fill="transparent"
			class="transition-all duration-300 ease-in-out"
		/>
	</svg>
	<span class="absolute text-xs font-medium text-brand">{Math.round(progress)}%</span>
</div>
