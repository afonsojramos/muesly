import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

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
		sourcemap: !!process.env.TAURI_ENV_DEBUG
	}
});
