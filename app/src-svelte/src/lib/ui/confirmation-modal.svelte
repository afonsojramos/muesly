<script lang="ts">
	import Dialog from '$lib/ui/dialog.svelte';
	import Button from '$lib/ui/button.svelte';

	interface Props {
		/** Whether the modal is open. */
		isOpen: boolean;
		/** Body text explaining what will be deleted. */
		text: string;
		onConfirm: () => void;
		onCancel: () => void;
		/** Heading shown above the text. Defaults to "Confirm Delete". */
		title?: string;
		/** Label for the confirm button. Defaults to "Delete". */
		confirmLabel?: string;
	}

	let {
		isOpen,
		text,
		onConfirm,
		onCancel,
		title = 'Confirm Delete',
		confirmLabel = 'Delete'
	}: Props = $props();
</script>

<Dialog
	open={isOpen}
	onOpenChange={(open) => {
		if (!open) onCancel();
	}}
	{title}
	class="max-w-md"
>
	<p class="text-sm text-muted-foreground">{text}</p>

	{#snippet footer()}
		<Button variant="ghost" onclick={onCancel}>Cancel</Button>
		<Button variant="destructive" onclick={onConfirm}>{confirmLabel}</Button>
	{/snippet}
</Dialog>
