<script lang="ts">
	import Button from '$lib/ui/Button.svelte';
	import { cn } from '$lib/utils/cn';
	import MueslyMark from './MueslyMark.svelte';

	// Transparent over the hero; translucent + bordered once scrolled past it.
	let scrolled = $state(false);
	$effect(() => {
		const onScroll = () => (scrolled = window.scrollY > 64);
		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => window.removeEventListener('scroll', onScroll);
	});
</script>

<header
	class={cn(
		'sticky top-0 z-50 border-b transition-colors duration-150 motion-reduce:transition-none',
		scrolled
			? 'border-border bg-background/80 backdrop-blur-md'
			: 'border-transparent bg-transparent'
	)}
>
	<nav
		aria-label="Primary"
		class="mx-auto flex max-w-6xl items-center justify-between px-6 py-3"
	>
		<a href="/" class="flex items-center gap-2" aria-label="muesly home">
			<MueslyMark class="h-7 w-7" />
			<span class="font-display text-lg font-semibold tracking-tight">muesly</span>
		</a>
		<Button href="/download" variant="accent">Download</Button>
	</nav>
</header>
