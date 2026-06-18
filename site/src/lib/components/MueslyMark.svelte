<script lang="ts">
	import { cn } from '$lib/utils/cn';

	// Decorative: the adjacent "muesly" wordmark carries the accessible name.
	let { class: className }: { class?: string } = $props();
</script>

<img src="/muesly.svg" alt="" width="28" height="28" class={cn('rounded-[6px]', className)} />
