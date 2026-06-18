// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';

// https://astro.build/config
// Tailwind 4 is wired via PostCSS (postcss.config.mjs) rather than the Vite
// plugin, which is incompatible with Astro 6's rolldown-based Vite.
export default defineConfig({
	site: 'https://muesly.ai',
	integrations: [icon(), sitemap()]
});
