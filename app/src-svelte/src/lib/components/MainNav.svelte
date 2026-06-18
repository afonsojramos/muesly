<script lang="ts">
	interface Props {
		title: string;
	}

	let { title }: Props = $props();
</script>

<div class="flex h-0 items-center border-b border-border">
	<div class="mx-auto w-full max-w-5xl px-8">
		<h1 class="text-2xl font-semibold">{title}</h1>
	</div>
</div>
