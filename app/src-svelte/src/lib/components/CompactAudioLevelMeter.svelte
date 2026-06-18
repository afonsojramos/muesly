<script lang="ts">
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
		rmsPercent / 100 < 0.3 ? 'bg-green-400' : rmsPercent / 100 < 0.7 ? 'bg-yellow-400' : 'bg-red-400'
	);
</script>

<div class={`flex items-center space-x-1 ${className}`}>
	<div class={`size-1.5 rounded-full ${isActive ? 'bg-green-400' : 'bg-muted-foreground/30'}`}></div>
	<div class="h-1.5 w-8 overflow-hidden rounded-sm bg-secondary">
		<div class={`h-full ${color} transition-all duration-150`} style={`width: ${rmsPercent}%`}></div>
	</div>
</div>
