// Copies the canonical repo-root legal docs (PRIVACY_POLICY.md, TERMS_OF_SERVICE.md)
// into the site so the /privacy and /terms routes can `?raw`-import them without
// reaching outside the project root. Runs on dev/build/check/prepare; the
// destinations are gitignored.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const contentDir = resolve(import.meta.dirname, '..', 'src/lib/content');

const docs = [
	['PRIVACY_POLICY.md', 'privacy-policy.md'],
	['TERMS_OF_SERVICE.md', 'terms-of-service.md']
];

for (const [srcName, destName] of docs) {
	const src = resolve(root, srcName);
	const dest = resolve(contentDir, destName);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	console.log(`[copy-legal-docs] ${src} -> ${dest}`);
}
