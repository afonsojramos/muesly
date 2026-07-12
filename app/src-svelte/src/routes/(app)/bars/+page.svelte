<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { Check, Copy, Pencil, Plus, Search, Send, Trash2 } from '@lucide/svelte';

	import { cn } from '$lib/utils';
	import { navigate } from '$lib/navigation';
	import { toast } from '$lib/toast';
	import { barIcon, type Bar, type BarScope } from '$lib/bars/catalog';
	import { bars } from '$lib/stores/bars.svelte';
	import { globalChat } from '$lib/stores/global-chat.svelte';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import BarEditor from '$lib/components/bars/BarEditor.svelte';

	type Tab = 'discover' | 'mine';
	type ScopeFilter = 'all' | BarScope;

	let tab = $state<Tab>('discover');
	let query = $state('');
	let scopeFilter = $state<ScopeFilter>('all');

	let editorOpen = $state(false);
	let editingBar = $state<Bar | null>(null);
	let detail = $state<Bar | null>(null);

	onMount(() => {
		void bars.ensureLoaded();
	});

	const source = $derived(tab === 'mine' ? bars.mine : bars.catalog);
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return source.filter((r) => {
			if (scopeFilter !== 'all' && !r.scopes.includes(scopeFilter)) return false;
			if (!q) return true;
			return (
				r.title.toLowerCase().includes(q) ||
				r.description.toLowerCase().includes(q) ||
				(r.author?.toLowerCase().includes(q) ?? false)
			);
		});
	});

	const SCOPE_FILTERS: { value: ScopeFilter; label: string }[] = [
		{ value: 'all', label: 'All' },
		{ value: 'meeting', label: 'In a meeting' },
		{ value: 'global', label: 'Across meetings' },
	];

	function openCreate(): void {
		editingBar = null;
		editorOpen = true;
	}

	function openEdit(bar: Bar): void {
		editingBar = bar;
		editorOpen = true;
		detail = null;
	}

	async function copyPrompt(bar: Bar): Promise<void> {
		await navigator.clipboard.writeText(bar.prompt);
		toast.success('Prompt copied');
	}

	function runInHome(bar: Bar): void {
		detail = null;
		void navigate('/');
		void globalChat.send(bar.prompt);
	}

	async function remove(bar: Bar): Promise<void> {
		await bars.remove(bar.id);
		detail = null;
		toast.success('Bar deleted');
	}

	function scopeLabel(scope: BarScope): string {
		return scope === 'meeting' ? 'In a meeting' : 'Across meetings';
	}
</script>

<div class="flex h-screen flex-col overflow-hidden bg-background" in:fly={{ y: 20, duration: 300 }}>
	<div data-tauri-drag-region="deep" class="h-8 flex-shrink-0"></div>

	<div class="flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-[980px] px-8 pb-24 pt-4">
			<!-- Header -->
			<div class="mb-6 flex items-start justify-between gap-4">
				<div class="flex items-center gap-3">
					<div class="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
						<MueslyBar class="size-5" />
					</div>
					<div>
						<h1 class="text-2xl font-semibold tracking-tight">Muesly bars</h1>
						<p class="mt-1 text-sm text-muted-foreground">
							Reusable prompts you can drop into any meeting's chat or the Home chat.
						</p>
					</div>
				</div>
				<Button onclick={openCreate}>
					<Plus data-icon />
					New bar
				</Button>
			</div>

			<!-- Tabs + toolbar -->
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div class="flex items-center gap-1 rounded-full bg-secondary p-1">
					{#each [{ value: 'discover', label: 'Discover' }, { value: 'mine', label: 'My bars' }] as t (t.value)}
						<button
							type="button"
							onclick={() => (tab = t.value as Tab)}
							class={cn(
								'rounded-full px-3 py-1 text-sm transition-colors',
								tab === t.value
									? 'bg-card font-medium text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							{t.label}
						</button>
					{/each}
				</div>

				<div class="flex items-center gap-2">
					<div class="flex items-center gap-1">
						{#each SCOPE_FILTERS as f (f.value)}
							<button
								type="button"
								onclick={() => (scopeFilter = f.value)}
								class={cn(
									'rounded-full border px-2.5 py-1 text-xs transition-colors',
									scopeFilter === f.value
										? 'border-foreground/20 bg-secondary text-foreground'
										: 'border-transparent text-muted-foreground hover:text-foreground',
								)}
							>
								{f.label}
							</button>
						{/each}
					</div>
					<div class="relative">
						<Search
							class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input bind:value={query} placeholder="Search…" class="h-9 w-48 pl-8" />
					</div>
				</div>
			</div>

			<!-- Grid -->
			{#if filtered.length === 0}
				<div class="py-20 text-center text-sm text-muted-foreground">
					{#if tab === 'mine'}
						No bars yet. Create one to reuse a prompt across meetings.
					{:else}
						No bars match your search.
					{/if}
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each filtered as bar (bar.id)}
						{@const Icon = barIcon(bar.icon)}
						<Card.Root
							class="flex cursor-pointer flex-col transition-colors hover:border-foreground/20"
							onclick={() => (detail = bar)}
						>
							<Card.Header>
								<div
									class="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground"
								>
									<Icon class="size-4" />
								</div>
							</Card.Header>
							<Card.Content class="flex flex-1 flex-col">
								<h3 class="text-sm font-medium">{bar.title}</h3>
								<p class="mt-1 line-clamp-2 text-sm text-muted-foreground">{bar.description}</p>
								<div class="mt-3 flex items-center gap-2">
									{#if bar.author}
										<span class="text-xs text-muted-foreground">{bar.author}</span>
									{:else if bar.source === 'user'}
										<Badge variant="secondary">Yours</Badge>
									{:else if bar.source === 'builtin'}
										<span class="text-xs text-muted-foreground">muesly</span>
									{/if}
								</div>
							</Card.Content>
						</Card.Root>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Bar detail / preview -->
<Dialog.Root open={detail !== null} onOpenChange={(o) => !o && (detail = null)}>
	<Dialog.Content class="sm:max-w-[560px]">
		{#if detail}
			{@const Icon = barIcon(detail.icon)}
			<div class="flex items-center gap-3">
				<div
					class="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground"
				>
					<Icon class="size-4" />
				</div>
				<div class="min-w-0">
					<Dialog.Title>{detail.title}</Dialog.Title>
					{#if detail.author}
						<p class="text-xs text-muted-foreground">by {detail.author}</p>
					{/if}
				</div>
			</div>

			<Dialog.Description>{detail.description}</Dialog.Description>

			<div class="flex flex-wrap gap-1.5">
				{#each detail.scopes as scope (scope)}
					<Badge variant="outline">{scopeLabel(scope)}</Badge>
				{/each}
			</div>

			<div
				class="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-secondary p-3 text-sm text-secondary-foreground"
			>
				{detail.prompt}
			</div>

			<Dialog.Footer class="sm:justify-between">
				<div class="flex items-center gap-2">
					{#if detail.source === 'user'}
						<Button variant="outline" size="sm" onclick={() => detail && openEdit(detail)}>
							<Pencil data-icon />
							Edit
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="text-muted-foreground hover:text-destructive"
							onclick={() => detail && void remove(detail)}
						>
							<Trash2 data-icon />
							Delete
						</Button>
					{/if}
				</div>
				<div class="flex items-center gap-2">
					<Button variant="outline" size="sm" onclick={() => detail && void copyPrompt(detail)}>
						<Copy data-icon />
						Copy
					</Button>
					{#if detail.scopes.includes('global')}
						<Button size="sm" onclick={() => detail && runInHome(detail)}>
							<Send data-icon />
							Ask in Home
						</Button>
					{/if}
				</div>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<BarEditor bind:open={editorOpen} bar={editingBar} />
