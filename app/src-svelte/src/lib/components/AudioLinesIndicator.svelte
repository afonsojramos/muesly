<script lang="ts">
	import AudioLines from '@lucide/svelte/icons/audio-lines';
	import { cn } from '$lib/utils';

	interface Props {
		active?: boolean;
		class?: string;
	}

	let { active = false, class: className = '' }: Props = $props();
</script>

<AudioLines
	data-icon
	class={cn('audio-lines-indicator', className)}
	data-active={active ? '' : undefined}
/>

<style>
	:global(.audio-lines-indicator path) {
		transform-box: fill-box;
		transform-origin: center;
	}

	:global(.audio-lines-indicator[data-active] path),
	:global(.group:hover .audio-lines-indicator path) {
		animation: audio-line-movement 500ms ease-in-out infinite alternate;
	}

	:global(.audio-lines-indicator[data-active] path:nth-child(2n)),
	:global(.group:hover .audio-lines-indicator path:nth-child(2n)) {
		animation-delay: -250ms;
	}

	:global(.audio-lines-indicator[data-active] path:nth-child(3n)),
	:global(.group:hover .audio-lines-indicator path:nth-child(3n)) {
		animation-delay: -125ms;
	}

	@keyframes audio-line-movement {
		from {
			transform: scaleY(0.55);
		}
		to {
			transform: scaleY(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.audio-lines-indicator[data-active] path),
		:global(.group:hover .audio-lines-indicator path) {
			animation: none;
		}
	}
</style>
