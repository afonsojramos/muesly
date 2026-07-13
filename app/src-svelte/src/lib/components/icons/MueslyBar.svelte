<script lang="ts">
	/** Extra classes for sizing/color; unsized, it inherits button icon sizing. */
	let { class: className = '' }: { class?: string } = $props();
</script>

<!-- A muesly (granola) bar in lucide's visual language: 24x24, currentColor
     stroke, round caps/joins. -->
<svg
	xmlns="http://www.w3.org/2000/svg"
	width="24"
	height="24"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
>
	<rect x="2" y="7" width="20" height="10" rx="3" />
	<path d="M7 11h.01" />
	<path d="M11 13.5h.01" />
	<path d="M15 10.5h.01" />
	<path d="M17.5 13.5h.01" />
</svg>
