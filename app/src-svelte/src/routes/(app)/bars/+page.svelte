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
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import * as Tooltip from '$lib/components/ui/tooltip';
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
				? 'Featured'
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
		<div class="mx-auto w-full max-w-[1120px] px-6 pb-24 pt-3 sm:px-8">
			<!-- Header -->
			<div class="mb-5 flex items-start justify-between gap-4">
				<div class="flex items-center gap-3">
					<div
						class="flex size-9 items-center justify-center rounded-[11px] bg-brand/10 text-brand"
					>
						<MueslyBar class="size-[18px]" />
					</div>
					<div>
						<h1 class="text-balance text-2xl font-semibold tracking-tight">Muesly bars</h1>
						<p class="mt-0.5 text-pretty text-sm text-muted-foreground">
							Reusable prompts for your meetings and Home chat.
						</p>
					</div>
				</div>
				<Button
					variant="brand"
					size="lg"
					class="active:scale-[0.96] transition-transform"
					onclick={openCreate}
				>
					<Plus data-icon />
					Create bar
				</Button>
			</div>

			<!-- Views -->
			<div class="mb-4 border-b border-border/70">
				<div class="flex items-center gap-1" aria-label="Bar views">
					{#each [{ value: 'discover', label: 'Discover' }, { value: 'menu', label: 'Added' }, { value: 'mine', label: 'Created by me' }] as t (t.value)}
						<Button
							variant="ghost"
							onclick={() => (tab = t.value as Tab)}
							class={cn(
								'relative h-10 rounded-none px-3 text-sm transition-colors after:absolute after:inset-x-3 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 after:transition-opacity',
								tab === t.value
									? 'bg-transparent text-foreground after:opacity-100 hover:bg-transparent'
									: 'text-muted-foreground hover:text-foreground',
							)}
							aria-pressed={tab === t.value}
						>
							{t.label}
						</Button>
					{/each}
				</div>
			</div>

			<!-- Search + collection -->
			<div class="mb-3 flex min-w-0 items-center gap-2">
				<div class="relative min-w-0 flex-1">
					<Search
						class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						bind:value={query}
						placeholder="Search bars…"
						aria-label="Search bars"
						class="h-8 w-full bg-muted/40 pl-9 shadow-none"
					/>
				</div>
				<div class="shrink-0">
					{#if tab === 'discover'}
						<Select.Root
							type="single"
							value={categoryFilter}
							onValueChange={(value) => value && (categoryFilter = value as CategoryFilter)}
						>
							<Select.Trigger class="w-48" aria-label="Filter by collection">
								<span class="truncate">Collection: {categoryFilterLabel}</span>
							</Select.Trigger>
							<Select.Content>
								<Select.Group>
									<Select.Item value="featured" label="Featured">Featured</Select.Item>
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
				</div>
			</div>

			<!-- Scenario filters -->
			<div
				class="mb-4 max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				<ToggleGroup.Root
					type="single"
					value={scenarioFilter}
					onValueChange={(value) => value && (scenarioFilter = value as ScenarioFilter)}
					variant="default"
					size="sm"
					spacing={1}
					aria-label="Filter bars by when they are used"
					class="w-max bg-transparent p-0"
				>
					{#each SCENARIO_FILTERS as f (f.value)}
						<ToggleGroup.Item
							value={f.value}
							class="h-9 whitespace-nowrap rounded-lg px-3 text-sm text-muted-foreground ring-1 ring-transparent transition-[color,background-color,box-shadow] hover:bg-muted/60 data-[state=on]:bg-secondary data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-sm"
						>
							{f.label}
						</ToggleGroup.Item>
					{/each}
				</ToggleGroup.Root>
			</div>

			<!-- Grid -->
			{#if filtered.length === 0}
				<div class="py-20 text-center text-sm text-muted-foreground">
					{#if tab === 'mine'}
						No bars yet. Create one to reuse a prompt across meetings.
					{:else if tab === 'menu'}
						You haven't added any bars yet.
					{:else}
						No bars match your search.
					{/if}
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each filtered as bar (bar.id)}
						{@const Icon = barIcon(bar.icon)}
						<Card.Root
							size="sm"
							class="relative min-h-44 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(0,0,0,0.08)] hover:ring-foreground/15"
						>
							<Button
								variant="ghost"
								class="absolute inset-0 z-0 h-full w-full rounded-xl p-0 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
								onclick={() => (detail = bar)}
								aria-label={`Open ${bar.title}`}
							/>
							<Card.Header class="pointer-events-none relative z-10 items-center">
								<div class="flex min-w-0 items-center gap-2.5">
									<div
										class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground"
									>
										<Icon class="size-4" />
									</div>
									<h3 class="truncate text-sm font-semibold">{bar.title}</h3>
								</div>
								{#if tab === 'menu'}
									<Card.Action>
										<Button
											variant={bars.isPinned(bar) ? 'secondary' : 'ghost'}
											size="icon"
											class="pointer-events-auto size-10 text-muted-foreground"
											onclick={(event) => togglePinned(event, bar)}
											aria-label={`${bars.isPinned(bar) ? 'Unpin' : 'Pin'} ${bar.title}`}
											aria-pressed={bars.isPinned(bar)}
										>
											{#if bars.isPinned(bar)}<PinOff data-icon />{:else}<Pin data-icon />{/if}
										</Button>
									</Card.Action>
								{:else if bar.source !== 'user'}
									<Card.Action>
										<Tooltip.Provider>
											<Tooltip.Root>
												<Tooltip.Trigger>
													{#snippet child({ props })}
														<Button
															{...props}
															variant={bars.isInMenu(bar) ? 'secondary' : 'outline'}
															size="sm"
															class="pointer-events-auto h-10 min-w-16 rounded-lg active:scale-[0.96] transition-transform"
															onclick={(event) => toggleInMenu(event, bar)}
															aria-pressed={bars.isInMenu(bar)}
															aria-label={`${bars.isInMenu(bar) ? 'Remove' : 'Add'} ${bar.title} ${bars.isInMenu(bar) ? 'from' : 'to'} your menu`}
														>
															{#if bars.isInMenu(bar)}
																<Check data-icon /> Added
															{:else}
																<Plus data-icon /> Add
															{/if}
														</Button>
													{/snippet}
												</Tooltip.Trigger>
												<Tooltip.Content>
													{bars.isInMenu(bar)
														? 'Remove from your Muesly bar menu'
														: 'Add to your Muesly bar menu'}
												</Tooltip.Content>
											</Tooltip.Root>
										</Tooltip.Provider>
									</Card.Action>
								{/if}
							</Card.Header>
							<Card.Content class="pointer-events-none relative z-10 flex flex-1 flex-col">
								<p
									class="line-clamp-2 min-h-10 text-pretty text-sm leading-5 text-muted-foreground"
								>
									{bar.description}
								</p>
								<div class="mt-auto flex items-end justify-between gap-2 pt-3">
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
										<Tooltip.Provider>
											<Tooltip.Root>
												<Tooltip.Trigger>
													{#snippet child({ props })}
														<Button
															{...props}
															variant="ghost"
															size="sm"
															aria-label={`${bars.usesFor(bar.id).toLocaleString()} uses across Muesly`}
															class="pointer-events-auto h-10 shrink-0 cursor-default gap-1 px-1.5 text-xs tabular-nums text-muted-foreground hover:bg-transparent hover:text-muted-foreground"
														>
															<Sparkles class="size-3" />
															{formatUses(bars.usesFor(bar.id))}
														</Button>
													{/snippet}
												</Tooltip.Trigger>
												<Tooltip.Content>
													Used {bars.usesFor(bar.id).toLocaleString()}
													{bars.usesFor(bar.id) === 1 ? 'time' : 'times'} across Muesly
												</Tooltip.Content>
											</Tooltip.Root>
										</Tooltip.Provider>
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

			{#if bars.isInMenu(detail)}
				<div class="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2">
					<span class="text-sm text-muted-foreground">Menu position</span>
					<div class="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							class="h-10"
							onclick={() => detail && bars.moveInMenu(detail, -1)}
						>
							<ArrowUp data-icon />
							Move up
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="h-10"
							onclick={() => detail && bars.moveInMenu(detail, 1)}
						>
							<ArrowDown data-icon />
							Move down
						</Button>
					</div>
				</div>
			{/if}

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
