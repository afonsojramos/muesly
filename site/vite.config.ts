import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Plugin order is load-bearing: tailwindcss() must come before sveltekit().
	plugins: [tailwindcss(), sveltekit()],
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.ts']
	}
});
