<script lang="ts">
	import { onMount } from 'svelte';
	import Star from '@lucide/svelte/icons/star';
	import { reveal } from '$lib/actions/reveal';
	import { GITHUB_URL } from '$lib/config';
	import Button from '$lib/ui/Button.svelte';
	import Section from '$lib/ui/Section.svelte';

	// Real star count via the public GitHub API (progressive enhancement). On
	// failure or rate-limit, the button shows without a number — never faked.
	let stars = $state<number | null>(null);
	onMount(async () => {
		try {
			const res = await fetch('https://api.github.com/repos/afonsojramos/muesly');
			if (res.ok) {
				const data = await res.json();
				if (typeof data.stargazers_count === 'number') stars = data.stargazers_count;
			}
		} catch {
			// ignore — leave stars null
		}
	});
</script>

<Section class="py-16 text-center md:py-24">
	<div class="mx-auto max-w-2xl" use:reveal>
		<h2 class="font-display text-3xl font-semibold tracking-tight md:text-4xl">
			Free and open source
		</h2>
		<p class="mt-3 text-muted-foreground">
			muesly is MIT-licensed and built in the open. Inspect every line, file an issue, or send a pull
			request.
		</p>
		<div class="mt-7 flex justify-center">
			<Button href={GITHUB_URL} size="lg" target="_blank" rel="noopener noreferrer">
				<Star class="h-4 w-4" aria-hidden="true" />
				Star on GitHub
				{#if stars !== null}
					<span class="tabular-nums opacity-80">{stars.toLocaleString()}</span>
				{/if}
			</Button>
		</div>
	</div>
</Section>
