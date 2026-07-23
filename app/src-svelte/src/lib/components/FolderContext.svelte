<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Pin, PinOff, Plus, Trash2 } from '@lucide/svelte';

	import { cn } from '$lib/utils';
	import type { FolderContextItem } from '$lib/bindings';
	import {
		FOLDER_CONTEXT_KINDS,
		folderContext,
		type FolderContextKind,
	} from '$lib/stores/folder-context.svelte';
	import IconButton from '$lib/components/IconButton.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';

	interface Props {
		folderId: string;
	}

	let { folderId }: Props = $props();

	let draftKind = $state<FolderContextKind>('note');
	let draftContent = $state('');
	let saving = $state(false);

	const items = $derived(folderContext.acceptedFor(folderId));
	const canAdd = $derived(draftContent.trim().length > 0 && !saving);

	onMount(() => {
		void folderContext.load(folderId);
	});

	async function add(): Promise<void> {
		if (!canAdd) return;
		saving = true;
		const ok = await folderContext.save({
			id: null,
			folder_id: folderId,
			kind: draftKind,
			content: draftContent.trim(),
			pinned: false,
		});
		saving = false;
		if (ok) {
			draftContent = '';
			draftKind = 'note';
		}
	}

	async function togglePin(item: FolderContextItem): Promise<void> {
		await folderContext.save({
			id: item.id,
			folder_id: folderId,
			kind: item.kind,
			content: item.content,
			pinned: !item.pinned,
		});
	}

	const KIND_LABELS: Record<string, string> = {
		note: 'Note',
		glossary: 'Glossary',
		preference: 'Preference',
		decision: 'Decision',
	};
</script>

<section class="mb-8 flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
	<div class="flex items-start justify-between gap-3">
		<div>
			<h3 class="text-sm font-semibold text-foreground">Folder memory</h3>
			<p class="mt-0.5 text-xs text-muted-foreground">
				Learned automatically from this folder's summaries and used when you chat or
				summarize here. Add, pin, or remove anything — it's all stored only on this device.
			</p>
		</div>
	</div>

	{#if items.length > 0}
		<ul class="flex flex-col divide-y divide-border">
			{#each items as item (item.id)}
				<li class="flex items-center gap-2 py-2">
					<Badge variant="outline" class="shrink-0">{KIND_LABELS[item.kind] ?? item.kind}</Badge>
					{#if item.source === 'extracted'}
						{#if item.source_meeting_id && item.source_meeting_title}
							<button
								type="button"
								class="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
								title={`Learned from “${item.source_meeting_title}” — open meeting`}
								onclick={() => void goto(`/meeting-details?id=${item.source_meeting_id}`)}
							>
								Auto · {item.source_meeting_title.length > 24
									? `${item.source_meeting_title.slice(0, 24)}…`
									: item.source_meeting_title}
							</button>
						{:else}
							<Badge variant="secondary" class="shrink-0 text-[10px]">Auto</Badge>
						{/if}
					{/if}
					<p class={cn('min-w-0 flex-1 text-sm text-foreground', !item.pinned && 'pl-0')}>
						{item.content}
					</p>
					<IconButton
						label={item.pinned ? 'Unpin' : 'Pin to the top'}
						onclick={() => void togglePin(item)}
					>
						{#if item.pinned}
							<PinOff class="size-4 text-accent" />
						{:else}
							<Pin class="size-4 text-muted-foreground" />
						{/if}
					</IconButton>
					<IconButton label="Delete" onclick={() => void folderContext.remove(folderId, item.id)}>
						<Trash2 class="size-4 text-muted-foreground" />
					</IconButton>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="flex flex-col gap-2">
		<div class="flex flex-wrap gap-1.5">
			{#each FOLDER_CONTEXT_KINDS as kind (kind)}
				<button
					type="button"
					onclick={() => (draftKind = kind)}
					class={cn(
						'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
						draftKind === kind
							? 'bg-primary text-primary-foreground'
							: 'bg-secondary text-muted-foreground hover:text-foreground',
					)}
				>
					{KIND_LABELS[kind]}
				</button>
			{/each}
		</div>
		<div class="flex items-end gap-2">
			<Textarea
				bind:value={draftContent}
				rows={1}
				placeholder={draftKind === 'glossary'
					? 'e.g. Atlas = the rewrite project'
					: draftKind === 'preference'
						? 'e.g. Always list decisions before action items'
						: draftKind === 'decision'
							? 'e.g. We decided to ship v1 without sync'
							: 'e.g. Maya owns payments'}
				class="min-h-9 flex-1 resize-none text-sm"
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void add();
					}
				}}
			/>
			<Button variant="outline" size="sm" disabled={!canAdd} onclick={() => void add()}>
				<Plus class="size-4" />
				Add
			</Button>
		</div>
	</div>

</section>
