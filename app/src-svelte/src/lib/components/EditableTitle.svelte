<script lang="ts">
	import { Pencil, Trash2 } from '@lucide/svelte';

	import Tooltip from '$lib/ui/tooltip.svelte';

	interface Props {
		title: string;
		isEditing: boolean;
		onStartEditing: () => void;
		onFinishEditing: () => void;
		onChange: (value: string) => void;
		onDelete?: () => void;
	}

	let { title, isEditing, onStartEditing, onFinishEditing, onChange, onDelete }: Props = $props();

	let textarea = $state<HTMLTextAreaElement>();

	// Auto-resize to fit content whenever the title or edit state changes.
	$effect(() => {
		// Touch `title` so this re-runs as the user types.
		void title;
		if (textarea && isEditing) {
			textarea.style.height = 'auto';
			textarea.style.height = `${textarea.scrollHeight}px`;
		}
	});

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			onFinishEditing();
		}
	}
</script>

{#if isEditing}
	<div class="flex-1">
		<!-- svelte-ignore a11y_autofocus -->
		<textarea
			bind:this={textarea}
			value={title}
			oninput={(e) => onChange(e.currentTarget.value)}
			onblur={onFinishEditing}
			onkeydown={handleKeydown}
			class="w-full resize-none overflow-hidden rounded border border-input bg-secondary px-3 py-1 text-2xl font-bold focus:outline-none focus:ring-2 focus:ring-ring"
			style="min-width: 300px; min-height: 40px;"
			autofocus
			rows={1}
		></textarea>
	</div>
{:else}
	<div class="group flex flex-1 items-center space-x-2">
		<button
			type="button"
			class="flex-1 cursor-pointer whitespace-pre-wrap rounded px-1 text-left text-2xl font-bold hover:bg-secondary"
			onclick={onStartEditing}
			aria-label="Edit title"
		>
			{title}
		</button>
		<div class="flex space-x-1">
			<Tooltip label="Edit title">
				{#snippet trigger()}
					<button
						onclick={onStartEditing}
						class="rounded p-1 opacity-0 transition-opacity duration-200 hover:bg-secondary group-hover:opacity-100"
						aria-label="Edit title"
					>
						<Pencil class="size-4" />
					</button>
				{/snippet}
			</Tooltip>
			{#if onDelete}
				<Tooltip label="Delete">
					{#snippet trigger()}
						<button
							onclick={onDelete}
							class="rounded p-1 text-destructive opacity-0 transition-opacity duration-200 hover:bg-secondary group-hover:opacity-100"
							aria-label="Delete"
						>
							<Trash2 class="size-4" />
						</button>
					{/snippet}
				</Tooltip>
			{/if}
		</div>
	</div>
{/if}
