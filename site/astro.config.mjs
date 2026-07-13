// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	site: 'https://muesly.ai',
	// Astro 7 changed the default to JSX-style whitespace stripping, which drops
	// rendered spaces between inline elements; keep the HTML-aware v6 behavior.
	compressHTML: true,
	integrations: [icon(), sitemap()],
	vite: {
		plugins: [tailwindcss()],
	},
});
