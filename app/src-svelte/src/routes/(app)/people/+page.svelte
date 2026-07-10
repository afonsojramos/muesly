<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import UsersIcon from '@lucide/svelte/icons/users';

	import { commands } from '$lib/bindings';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { toast } from '$lib/toast';

	interface PersonMeeting {
		meeting_id: string;
		title: string;
		created_at: string;
	}
	interface PersonGroup {
		name: string;
		meeting_count: number;
		meetings: PersonMeeting[];
	}

	let people = $state<PersonGroup[]>([]);
	let loading = $state(true);
	let expanded = $state<string | null>(null);

	onMount(() => {
		void (async () => {
			try {
				// Prefer typed bindings when regenerated; fall back to raw invoke name.
				const res = await (commands as { apiListPeople?: () => Promise<{ status: string; data: PersonGroup[]; error?: string }> }).apiListPeople?.();
				if (res && res.status === 'ok') {
					people = res.data;
				} else {
					const { invoke } = await import('@tauri-apps/api/core');
					people = (await invoke('api_list_people')) as PersonGroup[];
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
	<div class="flex items-center gap-3">
		<div class="flex size-10 items-center justify-center rounded-xl bg-secondary">
			<UsersIcon class="size-5 text-foreground" />
		</div>
		<div>
			<h1 class="font-display text-2xl font-semibold tracking-tight">People</h1>
			<p class="text-sm text-muted-foreground">
				Meetings grouped by calendar attendee (non-self).
			</p>
		</div>
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
		<ul class="flex flex-col gap-2">
			{#each people as person (person.name)}
				<li>
					<Card.Root>
						<Card.Header class="flex-row items-center justify-between gap-2 space-y-0 py-3">
							<button
								type="button"
								class="min-w-0 flex-1 text-left"
								onclick={() => (expanded = expanded === person.name ? null : person.name)}
							>
								<span class="font-medium">{person.name}</span>
								<span class="ml-2 text-sm text-muted-foreground tabular-nums">
									{person.meeting_count} meeting{person.meeting_count === 1 ? '' : 's'}
								</span>
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
	{/if}
</div>
