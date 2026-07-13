<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import {
		ArrowDown,
		ArrowUp,
		Check,
		Copy,
		Pencil,
		Pin,
		PinOff,
		Plus,
		Search,
		Send,
		Sparkles,
		Trash2,
	} from '@lucide/svelte';

	import { cn } from '$lib/utils';
	import { navigate } from '$lib/navigation';
	import { toast } from '$lib/toast';
	import {
		barCategory,
		BAR_CATEGORIES,
		barIcon,
		BAR_SCENARIOS,
		isFeaturedBar,
		type Bar,
		type BarCategory,
		type BarScenario,
	} from '$lib/bars/catalog';
	import { barVariables } from '$lib/bars/variables';
	import { bars } from '$lib/stores/bars.svelte';
	import { globalChat } from '$lib/stores/global-chat.svelte';
	import MueslyBar from '$lib/components/icons/MueslyBar.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import BarEditor from '$lib/components/bars/BarEditor.svelte';
	import RunBarDialog from '$lib/components/bars/RunBarDialog.svelte';

	type Tab = 'discover' | 'menu' | 'mine';
	type ScenarioFilter = 'all' | BarScenario;
	type CategoryFilter = 'all' | 'featured' | BarCategory;

	let tab = $state<Tab>('discover');
	let query = $state('');
	let scenarioFilter = $state<ScenarioFilter>('all');
	let categoryFilter = $state<CategoryFilter>('featured');

	let editorOpen = $state(false);
	let editingBar = $state<Bar | null>(null);
	let detail = $state<Bar | null>(null);
	let confirmingDelete = $state<Bar | null>(null);
	let runningBar = $state<Bar | null>(null);
	let runDialogOpen = $state(false);

	onMount(() => {
		void bars.ensureLoaded();
		void bars.loadPopular();
	});

	/** Compact usage count, e.g. 1700 -> "1.7k". */
	function formatUses(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
		return `${n}`;
	}

	const source = $derived(tab === 'mine' ? bars.mine : tab === 'menu' ? bars.menu : bars.catalog);
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = source.filter((b) => {
			if (scenarioFilter !== 'all' && !b.scenarios.includes(scenarioFilter)) return false;
			if (tab === 'discover' && categoryFilter === 'featured' && !isFeaturedBar(b)) return false;
			if (tab === 'discover' && categoryFilter !== 'all' && categoryFilter !== 'featured') {
				if (barCategory(b) !== categoryFilter) return false;
			}
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
	const categoryLabels = new Map(
		BAR_CATEGORIES.map((category) => [category.value, category.label]),
	);
	const categoryFilterLabel = $derived(
		categoryFilter === 'all'
			? 'All collections'
			: categoryFilter === 'featured'
				? 'Recommended'
				: (categoryLabels.get(categoryFilter) ?? categoryFilter),
	);

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

	function requestRunInHome(bar: Bar): void {
		if (barVariables(bar.prompt).length > 0) {
			runningBar = bar;
			runDialogOpen = true;
			return;
		}
		runInHome(bar, bar.prompt);
	}

	function runInHome(bar: Bar, prompt: string): void {
		detail = null;
		bars.recordRun(bar);
		void navigate('/');
		void globalChat.send(prompt, {
			barId: bar.id,
			barTitle: bar.title,
			barPrompt: prompt,
		});
	}

	async function remove(bar: Bar): Promise<void> {
		await bars.remove(bar.id);
		detail = null;
		toast.success('Bar deleted');
	}

	function scenarioLabel(scenario: BarScenario): string {
		return scenarioLabels.get(scenario) ?? scenario;
	}

	function toggleInMenu(event: MouseEvent, bar: Bar): void {
		event.stopPropagation();
		bars.toggleInMenu(bar);
	}

	function togglePinned(event: MouseEvent, bar: Bar): void {
		event.stopPropagation();
		bars.togglePinned(bar);
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
					{#each [{ value: 'discover', label: 'Discover' }, { value: 'menu', label: 'My menu' }, { value: 'mine', label: 'My bars' }] as t (t.value)}
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
					{#if tab === 'discover'}
						<Select.Root
							type="single"
							value={categoryFilter}
							onValueChange={(value) => value && (categoryFilter = value as CategoryFilter)}
						>
							<Select.Trigger class="w-40">{categoryFilterLabel}</Select.Trigger>
							<Select.Content>
								<Select.Group>
									<Select.Item value="featured" label="Recommended">Recommended</Select.Item>
									<Select.Item value="all" label="All collections">All collections</Select.Item>
									{#each BAR_CATEGORIES as category (category.value)}
										<Select.Item value={category.value} label={category.label}
											>{category.label}</Select.Item
										>
									{/each}
								</Select.Group>
							</Select.Content>
						</Select.Root>
					{/if}
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
					{:else if tab === 'menu'}
						No bars are currently shown in your menu.
					{:else}
						No bars match your search.
					{/if}
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each filtered as bar (bar.id)}
						{@const Icon = barIcon(bar.icon)}
						<Card.Root
							class="min-h-52 cursor-pointer transition-[box-shadow] hover:ring-foreground/20"
							onclick={() => (detail = bar)}
						>
							<Card.Header>
								<div
									class="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground"
								>
									<Icon class="size-4" />
								</div>
								{#if tab === 'menu'}
									<Card.Action>
										<Button
											variant={bars.isPinned(bar) ? 'secondary' : 'ghost'}
											size="icon"
											class="size-10 text-muted-foreground"
											onclick={(event) => togglePinned(event, bar)}
											aria-label={`${bars.isPinned(bar) ? 'Unpin' : 'Pin'} ${bar.title}`}
											aria-pressed={bars.isPinned(bar)}
										>
											{#if bars.isPinned(bar)}<PinOff data-icon />{:else}<Pin data-icon />{/if}
										</Button>
									</Card.Action>
								{:else if bar.source !== 'user'}
									<Card.Action>
										<Button
											variant={bars.isInMenu(bar) ? 'secondary' : 'ghost'}
											size="sm"
											class={cn('h-10', !bars.isInMenu(bar) && 'text-muted-foreground')}
											onclick={(event) => toggleInMenu(event, bar)}
											aria-pressed={bars.isInMenu(bar)}
											aria-label={`${bars.isInMenu(bar) ? 'Remove' : 'Add'} ${bar.title} ${bars.isInMenu(bar) ? 'from' : 'to'} Muesly bar menus`}
										>
											{#if bars.isInMenu(bar)}
												<Check data-icon />
												In menu
											{:else}
												<Plus data-icon />
												Add
											{/if}
										</Button>
									</Card.Action>
								{/if}
							</Card.Header>
							<Card.Content class="flex flex-1 flex-col">
								<h3 class="text-wrap-balance text-sm font-medium">{bar.title}</h3>
								<p class="mt-1 line-clamp-2 text-pretty text-sm text-muted-foreground">
									{bar.description}
								</p>
								<div class="mt-auto flex items-end justify-between gap-2 pt-5">
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
											class="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"
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
				<Badge variant="secondary">{categoryLabels.get(barCategory(detail))}</Badge>
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
					{:else}
						<Button variant="outline" size="sm" onclick={() => detail && openEdit(detail)}>
							<Pencil data-icon />
							Customize
						</Button>
					{/if}
				</div>
				<div class="flex items-center gap-2">
					{#if bars.isInMenu(detail)}
						<Button
							variant="ghost"
							size="icon"
							class="size-10"
							onclick={() => detail && bars.moveInMenu(detail, -1)}
							aria-label="Move earlier in menu"
						>
							<ArrowUp data-icon />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							class="size-10"
							onclick={() => detail && bars.moveInMenu(detail, 1)}
							aria-label="Move later in menu"
						>
							<ArrowDown data-icon />
						</Button>
					{/if}
					{#if detail.source !== 'user'}
						<Button variant="outline" size="sm" onclick={() => detail && bars.toggleInMenu(detail)}>
							{#if bars.isInMenu(detail)}
								<Check data-icon />
								In menu
							{:else}
								<Plus data-icon />
								Add to menu
							{/if}
						</Button>
					{/if}
					<Button variant="outline" size="sm" onclick={() => detail && void copyPrompt(detail)}>
						<Copy data-icon />
						Copy
					</Button>
					{#if detail.scenarios.some((s) => s === 'across' || s === 'before')}
						<Button size="sm" onclick={() => detail && requestRunInHome(detail)}>
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
<RunBarDialog
	bind:open={runDialogOpen}
	bar={runningBar}
	onRun={(prompt) => runningBar && runInHome(runningBar, prompt)}
/>
