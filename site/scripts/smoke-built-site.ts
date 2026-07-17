import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const routes = [
	'index.html',
	'404.html',
	'download/index.html',
	'privacy/index.html',
	'terms/index.html',
	'compare/index.html',
	'compare/otter/index.html',
	'compare/granola/index.html',
	'compare/fireflies/index.html',
];

const failures: string[] = [];

for (const route of routes) {
	const path = resolve(dist, route);
	if (!existsSync(path)) {
		failures.push(`missing route: ${route}`);
		continue;
	}

	const html = readFileSync(path, 'utf8');
	if (!html.includes('<title>')) failures.push(`missing title: ${route}`);
	if (!html.includes('rel="canonical"')) failures.push(`missing canonical URL: ${route}`);
	if (!html.includes('property="og:image"')) failures.push(`missing social image: ${route}`);
	if (/href="(?:undefined|null)"/.test(html)) failures.push(`invalid link value: ${route}`);
}

for (const asset of ['_headers', 'og.png', 'favicon.svg', 'sitemap.xml', 'sitemap-0.xml']) {
	if (!existsSync(resolve(dist, asset))) failures.push(`missing production asset: ${asset}`);
}

const robots = readFileSync(resolve(dist, 'robots.txt'), 'utf8');
if (!robots.includes('Sitemap: https://muesly.ai/sitemap.xml')) {
	failures.push('robots.txt does not advertise the canonical sitemap URL');
}

const sitemap = readFileSync(resolve(dist, 'sitemap.xml'), 'utf8');
if (!sitemap.includes('<loc>https://muesly.ai/sitemap-0.xml</loc>')) {
	failures.push('canonical sitemap does not reference the generated sitemap chunk');
}

if (failures.length) {
	throw new Error(
		`Built-site smoke test failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
	);
}

console.log(`Smoke-tested ${routes.length} routes and production assets.`);
