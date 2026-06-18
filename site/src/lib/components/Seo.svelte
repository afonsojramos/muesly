<script lang="ts">
	import { page } from '$app/state';
	import { SITE_URL } from '$lib/config';

	const DEFAULT_TITLE = 'muesly — private, on-device meeting notes';
	const DEFAULT_DESC =
		'muesly records, transcribes, and summarizes your meetings on your device. Open source, no account required, on-device by default.';

	let {
		title = DEFAULT_TITLE,
		description = DEFAULT_DESC,
		image = `${SITE_URL}/og.png`,
		canonical
	}: { title?: string; description?: string; image?: string; canonical?: string } = $props();

	const url = $derived(canonical ?? `${SITE_URL}${page.url.pathname}`);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	<meta property="og:type" content="website" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={image} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={image} />
</svelte:head>
