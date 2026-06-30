<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Tooltip from '$lib/components/ui/tooltip';

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
		<Textarea
			bind:ref={textarea}
			value={title}
			oninput={(e) => onChange(e.currentTarget.value)}
			onblur={onFinishEditing}
			onkeydown={handleKeydown}
			class="resize-none overflow-hidden bg-secondary px-3 py-1 text-2xl font-bold"
			style="min-width: 300px; min-height: 40px;"
			autofocus
			rows={1}
		/>
	</div>
{:else}
	<div class="group flex flex-1 items-center gap-2">
		<button
			type="button"
			class="flex-1 cursor-pointer whitespace-pre-wrap rounded px-1 text-left text-2xl font-bold hover:bg-secondary"
			onclick={onStartEditing}
			aria-label="Edit title"
		>
			{title}
		</button>
		<div class="flex gap-1">
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								onclick={onStartEditing}
								class="opacity-0 transition-opacity duration-200 group-hover:opacity-100"
								aria-label="Edit title"
							>
								<PencilIcon />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Edit title</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
			{#if onDelete}
				<Tooltip.Provider delayDuration={300}>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									onclick={onDelete}
									class="text-destructive opacity-0 transition-opacity duration-200 group-hover:opacity-100"
									aria-label="Delete"
								>
									<Trash2Icon />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>Delete</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			{/if}
		</div>
	</div>
{/if}
