<script lang="ts">
	import { cn } from '$lib/utils';
	import type { BarInput } from '$lib/bindings';
	import { BAR_ICON_NAMES, barIcon, type Bar, type BarScope } from '$lib/bars/catalog';
	import { bars } from '$lib/stores/bars.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';

	interface Props {
		open: boolean;
		/** The bar being edited, or null to create a new one. */
		bar?: Bar | null;
		onSaved?: (bar: Bar) => void;
	}

	let { open = $bindable(), bar = null, onSaved }: Props = $props();

	let title = $state('');
	let description = $state('');
	let prompt = $state('');
	let icon = $state('sparkles');
	let inMeeting = $state(true);
	let inGlobal = $state(false);
	let saving = $state(false);

	// Reset the form whenever the dialog opens (create = blank, edit = prefill).
	let lastOpen = false;
	$effect(() => {
		if (open && !lastOpen) {
			title = bar?.title ?? '';
			description = bar?.description ?? '';
			prompt = bar?.prompt ?? '';
			icon = bar?.icon ?? 'sparkles';
			inMeeting = bar ? bar.scopes.includes('meeting') : true;
			inGlobal = bar ? bar.scopes.includes('global') : false;
		}
		lastOpen = open;
	});

	const canSave = $derived(
		title.trim().length > 0 && prompt.trim().length > 0 && (inMeeting || inGlobal),
	);

	async function save(): Promise<void> {
		if (!canSave || saving) return;
		saving = true;
		const scopes: BarScope[] = [];
		if (inMeeting) scopes.push('meeting');
		if (inGlobal) scopes.push('global');
		const input: BarInput = {
			// Only reuse the id when editing an existing *user* bar.
			id: bar?.source === 'user' ? bar.id : null,
			title: title.trim(),
			description: description.trim(),
			prompt: prompt.trim(),
			scopes,
			icon,
		};
		const saved = await bars.save(input);
		saving = false;
		if (saved) {
			open = false;
			onSaved?.(saved);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-[560px]">
		<Dialog.Title>{bar?.source === 'user' ? 'Edit bar' : 'New bar'}</Dialog.Title>
		<Dialog.Description>
			A muesly bar is a reusable prompt you can run from a meeting's chat or the Home chat.
		</Dialog.Description>

		<div class="flex flex-col gap-4 py-2">
			<div class="flex flex-col gap-1.5">
				<Label for="bar-title">Title</Label>
				<Input id="bar-title" bind:value={title} placeholder="e.g. Weekly recap" />
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="bar-desc">Description</Label>
				<Input
					id="bar-desc"
					bind:value={description}
					placeholder="One line describing what it does"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="bar-prompt">Prompt</Label>
				<Textarea
					id="bar-prompt"
					bind:value={prompt}
					placeholder="What should the assistant do?"
					rows={6}
					class="resize-y"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label>Where it appears</Label>
				<div class="flex flex-col gap-2">
					<label class="flex items-center gap-2 text-sm">
						<Checkbox bind:checked={inMeeting} />
						In a meeting's chat
					</label>
					<label class="flex items-center gap-2 text-sm">
						<Checkbox bind:checked={inGlobal} />
						In the Home chat (across meetings)
					</label>
				</div>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label>Icon</Label>
				<div class="flex flex-wrap gap-1.5">
					{#each BAR_ICON_NAMES as name (name)}
						{@const Icon = barIcon(name)}
						<button
							type="button"
							onclick={() => (icon = name)}
							aria-label={name}
							aria-pressed={icon === name}
							class={cn(
								'flex size-9 items-center justify-center rounded-lg border transition-colors',
								icon === name
									? 'border-primary bg-primary/10 text-foreground'
									: 'border-border text-muted-foreground hover:bg-secondary',
							)}
						>
							<Icon class="size-4" />
						</button>
					{/each}
				</div>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button disabled={!canSave || saving} onclick={() => void save()}>
				{bar?.source === 'user' ? 'Save changes' : 'Create bar'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
