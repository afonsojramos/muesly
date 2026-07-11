<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import { cn } from '$lib/utils';

	interface Props {
		/** The currently displayed label (assigned name or "Speaker N"). */
		label: string;
		/** The diarized cluster this label names. */
		speakerId: number;
		/** Remote attendee names offered as a one-tap shortlist. */
		shortlist: string[];
		/** Persist the assignment for this cluster. */
		onAssign: (speakerId: number, name: string) => void | Promise<void>;
	}

	let { label, speakerId, shortlist, onAssign }: Props = $props();

	let open = $state(false);
	let query = $state('');

	// Offer to use a typed name when it isn't already in the shortlist.
	const canCreate = $derived(
		query.trim().length > 0 &&
			!shortlist.some((n) => n.toLowerCase() === query.trim().toLowerCase()),
	);

	async function assign(name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) return;
		open = false;
		query = '';
		await onAssign(speakerId, trimmed);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class={cn(
					'mb-0.5 rounded text-[11px] font-medium text-muted-foreground',
					'hover:text-foreground hover:underline',
				)}
				aria-label="Rename speaker"
			>
				{label}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-56 p-0">
		<Command.Root>
			<Command.Input placeholder="Name this speaker" bind:value={query} />
			<Command.List>
				<Command.Empty>No matches.</Command.Empty>
				{#if shortlist.length > 0}
					<Command.Group>
						<!-- Keyed by index: a duplicate display name (deduped upstream, but
						     be robust) must never collide on a keyed-each. -->
						{#each shortlist as name, i (i)}
							<Command.Item value={name} onSelect={() => assign(name)}>
								<span class="truncate">{name}</span>
							</Command.Item>
						{/each}
					</Command.Group>
				{/if}
				{#if canCreate}
					{#if shortlist.length > 0}
						<Command.Separator />
					{/if}
					<Command.Item value={`use-${query}`} onSelect={() => assign(query)}>
						<span class="text-brand">Use “{query.trim()}”</span>
					</Command.Item>
				{/if}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
