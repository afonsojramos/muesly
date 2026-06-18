import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Recommended Cloudflare adapter (2026): builds for Workers Static Assets.
		// Every route is prerendered (see src/routes/+layout.ts), so matched routes
		// are served as static files; the emitted _worker.js only handles fallback.
		adapter: adapter({ fallback: 'plaintext' })
	}
};

export default config;
