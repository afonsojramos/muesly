interface Env {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.protocol !== 'https:' || url.hostname === 'www.muesly.ai') {
			url.protocol = 'https:';
			url.hostname = 'muesly.ai';
			return Response.redirect(url, 308);
		}

		if (url.pathname === '/sitemap-index.xml') {
			url.pathname = '/sitemap.xml';
			return Response.redirect(url, 308);
		}

		return env.ASSETS.fetch(request);
	},
};
