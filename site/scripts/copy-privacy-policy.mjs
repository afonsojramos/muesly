// Copies the canonical repo-root PRIVACY_POLICY.md into the site so the
// /privacy route can `?raw`-import it without reaching outside the project
// root. Runs on dev/build/check/prepare; the destination is gitignored.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const src = resolve(root, 'PRIVACY_POLICY.md');
const dest = resolve(import.meta.dirname, '..', 'src/lib/content/privacy-policy.md');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-privacy-policy] ${src} -> ${dest}`);
