import { defineConfig } from 'vite-plus';

// Config only for `vp lint` / `vp fmt` (oxlint + oxfmt); the worker itself builds
// with wrangler, which ignores this file. Matches the app's style.
export default defineConfig({
	lint: {
		ignorePatterns: ['drizzle/**', '.wrangler/**'],
		plugins: ['typescript', 'import', 'unicorn', 'oxc'],
	},
	fmt: {
		ignorePatterns: ['drizzle/**', '.wrangler/**'],
		useTabs: true,
		singleQuote: true,
		semi: true,
		printWidth: 100,
	},
});
