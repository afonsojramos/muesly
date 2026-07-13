// Config for `vp lint` / `vp fmt` (oxlint + oxfmt), read by the globally
// installed `vp`. We deliberately don't import `vite-plus` / add it as a dep —
// doing so perturbs Astro's dependency tree. Astro builds via astro.config.mjs
// and Vitest via vitest.config.ts, both of which ignore this file.
export default {
	lint: {
		ignorePatterns: ['dist/**', '.astro/**', 'src/env.d.ts'],
		plugins: ['typescript', 'import', 'unicorn', 'oxc'],
	},
	fmt: {
		ignorePatterns: ['dist/**', '.astro/**'],
		useTabs: true,
		singleQuote: true,
		semi: true,
		printWidth: 100,
	},
};
