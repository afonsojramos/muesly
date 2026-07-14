<script lang="ts">
	import UsersIcon from '@lucide/svelte/icons/users';

	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		participants: string[];
	}

	let { participants }: Props = $props();
</script>

{#if participants.length > 0}
	<Tooltip.Provider>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="h-10 px-1.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
						aria-label={`${participants.length} ${participants.length === 1 ? 'participant' : 'participants'}`}
					>
						<UsersIcon data-icon="inline-start" />
						<span class="tabular-nums">{participants.length}</span>
						{participants.length === 1 ? 'participant' : 'participants'}
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content
				side="bottom"
				sideOffset={8}
				arrowClasses="hidden"
				class="block w-64 max-w-[calc(100vw-2rem)] p-1.5"
			>
				<p class="px-2 pb-1.5 pt-1 font-medium text-primary-foreground/70">Participants</p>
				<ul
					class="flex max-h-[min(16rem,calc(100vh-8rem))] flex-col gap-1 overflow-y-auto rounded-sm px-2 pb-1"
				>
					{#each participants as name (name)}
						<li class="break-words py-0.5 text-sm leading-5">{name}</li>
					{/each}
				</ul>
			</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
{/if}
