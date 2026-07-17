import { describe, expect, it, vi } from 'vitest';
import worker from './worker';

const createEnv = () => ({
	ASSETS: {
		fetch: vi.fn(async () => new Response('asset')),
	},
});

describe('site worker', () => {
	it('redirects HTTP and www requests to the HTTPS apex URL', async () => {
		const env = createEnv();
		const response = await worker.fetch(
			new Request('http://www.muesly.ai/privacy/?source=test'),
			env,
		);

		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://muesly.ai/privacy/?source=test');
		expect(env.ASSETS.fetch).not.toHaveBeenCalled();
	});

	it('serves canonical requests from the static asset binding', async () => {
		const env = createEnv();
		const request = new Request('https://muesly.ai/download/');
		const response = await worker.fetch(request, env);

		expect(await response.text()).toBe('asset');
		expect(env.ASSETS.fetch).toHaveBeenCalledWith(request);
	});

	it("redirects Astro's sitemap index URL to the canonical sitemap URL", async () => {
		const env = createEnv();
		const response = await worker.fetch(
			new Request('https://muesly.ai/sitemap-index.xml?source=legacy'),
			env,
		);

		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://muesly.ai/sitemap.xml?source=legacy');
		expect(env.ASSETS.fetch).not.toHaveBeenCalled();
	});
});
