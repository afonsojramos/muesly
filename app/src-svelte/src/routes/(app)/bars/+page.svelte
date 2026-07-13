<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { Check, Copy, Pencil, Plus, Search, Send, Sparkles, Trash2 } from '@lucide/svelte';

	import { cn } from '$lib/utils';
	import { navigate } from '$lib/navigation';
	import { toast } from '$lib/toast';
	import { barIcon, BAR_SCENARIOS, type Bar, type BarScenario } from '$lib/bars/catalog';
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
	type ScenarioFilter = 'all' | BarScenario;

	let tab = $state<Tab>('discover');
	let query = $state('');
	let scenarioFilter = $state<ScenarioFilter>('all');

	let editorOpen = $state(false);
	let editingBar = $state<Bar | null>(null);
	let detail = $state<Bar | null>(null);
	let confirmingDelete = $state<Bar | null>(null);

	onMount(() => {
		void bars.ensureLoaded();
		void bars.loadPopular();
	});

	/** Compact usage count, e.g. 1700 -> "1.7k". */
	function formatUses(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
		return `${n}`;
	}

	const source = $derived(tab === 'mine' ? bars.mine : bars.catalog);
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = source.filter((b) => {
			if (scenarioFilter !== 'all' && !b.scenarios.includes(scenarioFilter)) return false;
			if (!q) return true;
			return b.title.toLowerCase().includes(q) || b.description.toLowerCase().includes(q);
		});
		// Discover surfaces the community's most-used bars first (stable otherwise).
		if (tab === 'discover') {
			return [...list].sort((a, b) => bars.usesFor(b.id) - bars.usesFor(a.id));
		}
		return list;
	});

	const SCENARIO_FILTERS: { value: ScenarioFilter; label: string }[] = [
		{ value: 'all', label: 'All' },
		...BAR_SCENARIOS.map((s) => ({ value: s.value as ScenarioFilter, label: s.label })),
	];
	const scenarioLabels = new Map(BAR_SCENARIOS.map((s) => [s.value, s.label]));

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
		bars.track(bar);
		void navigate('/');
		void globalChat.send(bar.prompt);
	}

	async function remove(bar: Bar): Promise<void> {
		await bars.remove(bar.id);
		detail = null;
		toast.success('Bar deleted');
	}

	function scenarioLabel(scenario: BarScenario): string {
		return scenarioLabels.get(scenario) ?? scenario;
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
						{#each SCENARIO_FILTERS as f (f.value)}
							<button
								type="button"
								onclick={() => (scenarioFilter = f.value)}
								class={cn(
									'rounded-full border px-2.5 py-1 text-xs transition-colors',
									scenarioFilter === f.value
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
								<div class="mt-3 flex items-center justify-between gap-2">
									<div class="flex min-w-0 flex-wrap items-center gap-1.5">
										{#if bar.source === 'user'}
											<Badge variant="secondary">Yours</Badge>
										{/if}
										{#each bar.scenarios as scenario (scenario)}
											<Badge variant="outline" class="text-muted-foreground">
												{scenarioLabel(scenario)}
											</Badge>
										{/each}
									</div>
									{#if bars.usesFor(bar.id) > 0}
										<span
											class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
											title={`${bars.usesFor(bar.id)} uses`}
										>
											<Sparkles class="size-3" />
											{formatUses(bars.usesFor(bar.id))}
										</span>
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
				</div>
			</div>

			<Dialog.Description>{detail.description}</Dialog.Description>

			<div class="flex flex-wrap gap-1.5">
				{#each detail.scenarios as scenario (scenario)}
					<Badge variant="outline">{scenarioLabel(scenario)}</Badge>
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
							onclick={() => (confirmingDelete = detail)}
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
					{#if detail.scenarios.some((s) => s === 'across' || s === 'before')}
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

<Dialog.Root open={confirmingDelete !== null} onOpenChange={(o) => !o && (confirmingDelete = null)}>
	<Dialog.Content class="sm:max-w-[400px]">
		<Dialog.Title>Delete this bar?</Dialog.Title>
		<Dialog.Description>
			{confirmingDelete ? `"${confirmingDelete.title}" will be permanently removed.` : ''}
		</Dialog.Description>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirmingDelete = null)}>Cancel</Button>
			<Button
				variant="destructive"
				onclick={() => {
					const bar = confirmingDelete;
					confirmingDelete = null;
					if (bar) void remove(bar);
				}}
			>
				Delete
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<BarEditor bind:open={editorOpen} bar={editingBar} />
