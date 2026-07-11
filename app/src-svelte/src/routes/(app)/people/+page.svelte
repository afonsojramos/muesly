<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import UsersIcon from '@lucide/svelte/icons/users';

	import { commands, type PersonGroup } from '$lib/bindings';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { formatSeconds } from '$lib/talk-time';
	import { toast } from '$lib/toast';

	let people = $state<PersonGroup[]>([]);
	let loading = $state(true);
	let expanded = $state<string | null>(null);
	/** When true, group people under company headings when company is known. */
	let groupByCompany = $state(true);

	type CompanyBucket = { key: string; label: string; people: PersonGroup[] };

	const buckets = $derived.by((): CompanyBucket[] => {
		if (!groupByCompany) {
			return [{ key: 'all', label: 'People', people }];
		}
		const map = new Map<string, PersonGroup[]>();
		for (const p of people) {
			const key = p.company?.trim() || '';
			const list = map.get(key) ?? [];
			list.push(p);
			map.set(key, list);
		}
		const named = [...map.entries()]
			.filter(([k]) => k.length > 0)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, list]) => ({ key: k, label: k, people: list }));
		const unorg = map.get('') ?? [];
		if (unorg.length > 0) {
			named.push({ key: '_none', label: 'No company', people: unorg });
		}
		return named.length > 0 ? named : [{ key: 'all', label: 'People', people }];
	});

	onMount(() => {
		void (async () => {
			try {
				const res = await commands.apiListPeople();
				if (res.status === 'ok') {
					people = res.data;
				} else {
					toast.error('Failed to load people', { description: res.error });
				}
			} catch (e) {
				toast.error('Failed to load people', { description: String(e) });
			} finally {
				loading = false;
			}
		})();
	});
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-6 p-8">
	<div class="flex items-center justify-between gap-4">
		<div class="flex items-center gap-3">
			<div class="flex size-10 items-center justify-center rounded-xl bg-secondary">
				<UsersIcon class="size-5 text-foreground" />
			</div>
			<div>
				<h1 class="font-display text-2xl font-semibold tracking-tight">People</h1>
				<p class="text-sm text-muted-foreground">
					Meetings grouped by calendar attendee (non-self), with company from email when known.
				</p>
			</div>
		</div>
		{#if people.length > 0}
			<Button variant="outline" size="sm" onclick={() => (groupByCompany = !groupByCompany)}>
				{groupByCompany ? 'Flat list' : 'By company'}
			</Button>
		{/if}
	</div>

	{#if loading}
		<p class="text-sm text-muted-foreground">Loading…</p>
	{:else if people.length === 0}
		<Card.Root>
			<Card.Content class="py-10 text-center text-sm text-muted-foreground">
				No attendee names yet. Connect a calendar and record a meeting with invitees.
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="flex flex-col gap-6">
			{#each buckets as bucket (bucket.key)}
				<section class="flex flex-col gap-2">
					{#if groupByCompany && buckets.length > 1}
						<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
							{bucket.label}
						</h2>
					{/if}
					<ul class="flex flex-col gap-2">
						{#each bucket.people as person (person.name)}
							<li>
								<Card.Root>
									<Card.Header class="flex-row items-center justify-between gap-2 space-y-0 py-3">
										<button
											type="button"
											class="min-w-0 flex-1 text-left"
											onclick={() => (expanded = expanded === person.name ? null : person.name)}
										>
											<span class="font-medium">{person.name}</span>
											{#if person.company && !groupByCompany}
												<span class="ml-2 text-sm text-muted-foreground">{person.company}</span>
											{/if}
											<span class="ml-2 text-sm text-muted-foreground tabular-nums">
												{person.meeting_count} meeting{person.meeting_count === 1 ? '' : 's'}
											</span>
											{#if person.speech_seconds != null}
												<span class="ml-2 text-sm text-muted-foreground tabular-nums">
													· spoke {formatSeconds(person.speech_seconds)}
												</span>
											{/if}
										</button>
									</Card.Header>
									{#if expanded === person.name}
										<Card.Content class="border-t border-border pt-3">
											<ul class="flex flex-col gap-1">
												{#each person.meetings as m (m.meeting_id)}
													<li>
														<Button
															variant="ghost"
															class="h-auto w-full justify-start px-2 py-1.5 font-normal"
															onclick={() => void goto(`/meeting-details?id=${m.meeting_id}`)}
														>
															<span class="truncate">{m.title || 'Untitled'}</span>
															{#if m.speech_seconds != null}
																<span
																	class="ml-auto pl-2 text-xs text-muted-foreground tabular-nums"
																>
																	{formatSeconds(m.speech_seconds)}
																</span>
															{/if}
														</Button>
													</li>
												{/each}
											</ul>
										</Card.Content>
									{/if}
								</Card.Root>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	{/if}
</div>
