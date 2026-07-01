import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// vite-plus (`vp lint` / `vp fmt`) reads these keys off the Vite config; Vite
// core ignores them. Declared here so the config type-checks without pulling in
// the vite-plus type override (we keep SvelteKit's own Vite for dev/build).
declare module 'vite' {
	interface UserConfig {
		lint?: Record<string, unknown>;
		fmt?: Record<string, unknown>;
	}
}

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Vite chatter clutters the Tauri runner output.
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
		watch: {
			ignored: ['**/src-tauri/**']
		}
	},
	envPrefix: ['VITE_', 'TAURI_ENV_*'],
	build: {
		// Modern ES baseline — Tauri 2 webviews all support es2022:
		//   - macOS WKWebView (Safari 14+ via Big Sur, the Tauri 2 minimum)
		//   - Windows WebView2 (Chromium 105+)
		//   - Linux WebKitGTK (recent)
		target: 'es2022',
		minify: !process.env.TAURI_ENV_DEBUG ? 'oxc' : false,
		// Debug: full sourcemaps. Release: 'hidden' so maps are emitted for upload
		// to PostHog (readable error-tracking stacks) without a public
		// sourceMappingURL; the upload step strips them before bundling.
		sourcemap: process.env.TAURI_ENV_DEBUG ? true : 'hidden'
	},

	// Linting via `vp lint` (forwarded to Oxlint). eslint-plugin-better-tailwindcss
	// runs as an Oxlint JS plugin. Tailwind v4 is CSS-first (no tailwind.config.js),
	// so point it at the CSS entry that imports tailwindcss.
	lint: {
		// Skip generated output and the shadcn-svelte primitives (verbatim registry
		// source; their `cn-*` marker classes and arbitrary variants are intentional).
		ignorePatterns: ['.svelte-kit/**', 'build/**', 'src/lib/components/ui/**'],
		plugins: ['typescript', 'import', 'unicorn', 'oxc'],
		jsPlugins: ['eslint-plugin-better-tailwindcss'],
		settings: {
			'better-tailwindcss': {
				entryPoint: 'src/app.css'
			}
		},
		rules: {
			'better-tailwindcss/no-unknown-classes': 'warn',
			'better-tailwindcss/no-duplicate-classes': 'warn',
			'better-tailwindcss/no-unnecessary-whitespace': 'warn',
			'better-tailwindcss/enforce-canonical-classes': ['warn', { collapse: false }],
			'better-tailwindcss/enforce-shorthand-classes': 'off'
		}
	},

	// Formatting via `vp fmt` (Oxfmt, Prettier-compatible) — match the existing
	// code style (tabs, single quotes, semicolons, 100 cols).
	fmt: {
		ignorePatterns: ['.svelte-kit/**', 'build/**'],
		useTabs: true,
		singleQuote: true,
		semi: true,
		printWidth: 100
	}
});
