/**
 * Scroll-reveal action: fades an element in when it scrolls into view.
 * Prerender-safe (only runs client-side) and reduced-motion aware. Without
 * JS the element renders normally, since the action never runs.
 */
export function reveal(node: HTMLElement) {
	if (typeof IntersectionObserver === 'undefined') return;

	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (reduce) {
		node.classList.add('reveal-shown');
		return;
	}

	node.classList.add('reveal-init');
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					node.classList.add('reveal-shown');
					observer.unobserve(node);
				}
			}
		},
		{ threshold: 0.12, rootMargin: '0px 0px -10% 0px' }
	);
	observer.observe(node);

	return {
		destroy() {
			observer.disconnect();
		}
	};
}
