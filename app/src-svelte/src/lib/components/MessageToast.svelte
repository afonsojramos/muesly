<script lang="ts">
	interface Props {
		message: string;
		type: 'success' | 'error';
		show: boolean;
		setShow: (show: boolean) => void;
	}

	let { message, type, show, setShow }: Props = $props();

	$effect(() => {
		const timer = setTimeout(() => setShow(false), 3000);
		return () => clearTimeout(timer);
	});
</script>

{#if show}
	<span class={type === 'success' ? 'text-green-500' : 'text-red-500'}>{message}</span>
{/if}
