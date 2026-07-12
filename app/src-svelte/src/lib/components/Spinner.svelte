<script lang="ts">
	/** Extra classes for sizing/color; unsized, it inherits button icon sizing. */
	let { class: className = '' }: { class?: string } = $props();
</script>

<!-- Rotates via SMIL inside the SVG raster instead of a CSS transform:
     WKWebView's compositor makes CSS-rotated layers orbit in some containers
     (observed in the fixed sidebar icon strip; Chromium and headless WebKit
     don't reproduce it). Same arc glyph as lucide's loader-circle. -->
<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
>
	<g>
		<path d="M21 12a9 9 0 1 1-6.219-8.56" />
		<animateTransform
			attributeName="transform"
			type="rotate"
			from="0 12 12"
			to="360 12 12"
			dur="1s"
			repeatCount="indefinite"
		/>
	</g>
</svg>
