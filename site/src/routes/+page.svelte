<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import WaveDivider from '$lib/components/WaveDivider.svelte';
	import Community from '$lib/components/sections/Community.svelte';
	import DownloadCta from '$lib/components/sections/DownloadCta.svelte';
	import FeatureGrid from '$lib/components/sections/FeatureGrid.svelte';
	import Hero from '$lib/components/sections/Hero.svelte';
	import HowItWorks from '$lib/components/sections/HowItWorks.svelte';
	import OpenSourceTrust from '$lib/components/sections/OpenSourceTrust.svelte';
	import PrivacyBlock from '$lib/components/sections/PrivacyBlock.svelte';
	import ProductShowcase from '$lib/components/sections/ProductShowcase.svelte';
</script>

<Seo />

<Hero />
<OpenSourceTrust />
<WaveDivider class="my-2" />
<HowItWorks />
<ProductShowcase />
<PrivacyBlock />
<FeatureGrid />
<Community />
<DownloadCta />
