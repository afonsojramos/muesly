<script lang="ts">
	import '../app.css';
	import SiteFooter from '$lib/components/SiteFooter.svelte';
	import SiteNav from '$lib/components/SiteNav.svelte';
	import { SITE_URL } from '$lib/config';

	let { children } = $props();

	// Site-wide structured data. First-party constant, safe to inline.
	const jsonLd = `<script type="application/ld+json">${JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'muesly',
		applicationCategory: 'BusinessApplication',
		operatingSystem: 'macOS, Windows, Linux',
		description:
			'Private, on-device AI meeting assistant. Records, transcribes, and summarizes meetings locally.',
		url: SITE_URL,
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
	})}<\/script>`;
</script>

<svelte:head>
	<meta property="og:site_name" content="muesly" />
	{@html jsonLd}
</svelte:head>

<div class="flex min-h-dvh flex-col">
	<SiteNav />
	<main class="flex-1">
		{@render children()}
	</main>
	<SiteFooter />
</div>
