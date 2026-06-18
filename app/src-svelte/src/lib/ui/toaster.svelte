<script lang="ts" module>
	import { createToaster } from '@ark-ui/svelte/toast';

	/** App-wide toaster instance. Module-scoped so it survives component remounts. */
	export const toaster = createToaster({
		placement: 'bottom-end',
		overlap: true,
		gap: 12,
		max: 4
	});
</script>

<script lang="ts">
	import { Toast, Toaster } from '@ark-ui/svelte/toast';
	import { X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { setToastImpl, type ToastOptions } from '$lib/toast';

	// Wire the toast abstraction to this Ark toaster so stores/hooks can call
	// toast.success(...) without importing UI.
	onMount(() => {
		const make = (type: 'success' | 'error' | 'info') => (message: string, opts?: ToastOptions) => {
			toaster.create({
				title: message,
				description: opts?.description,
				type,
				duration: opts?.duration,
				action: opts?.action
			});
		};
		setToastImpl({ success: make('success'), error: make('error'), info: make('info') });
	});

	const typeStyles: Record<string, string> = {
		success: 'border-l-4 border-l-green-500',
		error: 'border-l-4 border-l-destructive',
		info: 'border-l-4 border-l-accent'
	};
</script>

<Toaster {toaster}>
	{#snippet children(toast)}
		<Toast.Root
			class={`relative flex w-80 flex-col gap-1 rounded-md border bg-card p-4 text-card-foreground shadow-lg ${typeStyles[toast().type ?? 'info'] ?? ''}`}
		>
			{#if toast().title}
				<Toast.Title class="text-sm font-medium">{toast().title}</Toast.Title>
			{/if}
			{#if toast().description}
				<Toast.Description class="text-sm text-muted-foreground">
					{toast().description}
				</Toast.Description>
			{/if}
			{#if toast().action}
				<Toast.ActionTrigger
					class="mt-1.5 self-start rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary"
				>
					{toast().action?.label}
				</Toast.ActionTrigger>
			{/if}
			<Toast.CloseTrigger
				class="absolute right-2 top-2 rounded-sm opacity-60 hover:opacity-100"
				aria-label="Dismiss"
			>
				<X class="size-3.5" />
			</Toast.CloseTrigger>
		</Toast.Root>
	{/snippet}
</Toaster>
