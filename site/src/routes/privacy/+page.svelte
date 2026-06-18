<script lang="ts">
	import { marked } from 'marked';
	import sanitizeHtml from 'sanitize-html';
	import Seo from '$lib/components/Seo.svelte';
	import Section from '$lib/ui/Section.svelte';
	// Generated at build time from the repo-root PRIVACY_POLICY.md (single source
	// of truth). See site/scripts/copy-privacy-policy.mjs.
	import policy from '$lib/content/privacy-policy.md?raw';

	// First-party content, but sanitize defensively before {@html} so a stray
	// HTML tag a future editor adds to the markdown can't inject into the page.
	const rendered = sanitizeHtml(marked.parse(policy, { async: false }) as string, {
		allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2']),
		allowedAttributes: { a: ['href', 'target', 'rel'] }
	});
</script>

<Seo
	title="Privacy Policy — muesly"
	description="How muesly handles your data: meeting content stays on your device, analytics is opt-out, cloud LLMs are opt-in."
/>

<Section class="py-16 md:py-24">
	<article class="prose-muesly mx-auto max-w-2xl">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized first-party content -->
		{@html rendered}
	</article>
</Section>
