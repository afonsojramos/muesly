import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const generatedIndex = resolve(dist, 'sitemap-index.xml');
const canonicalSitemap = resolve(dist, 'sitemap.xml');

if (!existsSync(generatedIndex)) {
	throw new Error(`Astro sitemap index was not generated: ${generatedIndex}`);
}

copyFileSync(generatedIndex, canonicalSitemap);
console.log(`[create-sitemap-alias] ${generatedIndex} -> ${canonicalSitemap}`);
