import { osCta } from '$lib/cta';
import { detectOS, type OS } from '$lib/utils/detect-os';

/** Fade sections in on scroll; respects reduced motion and no-JS. */
function initReveal() {
	const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
	if (!els.length) return;

	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (reduce || typeof IntersectionObserver === 'undefined') {
		els.forEach((el) => el.classList.add('reveal-shown'));
		return;
	}

	els.forEach((el) => el.classList.add('reveal-init'));
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					entry.target.classList.add('reveal-shown');
					observer.unobserve(entry.target);
				}
			}
		},
		{ threshold: 0.12, rootMargin: '0px 0px -10% 0px' },
	);
	els.forEach((el) => observer.observe(el));
}

/** Sticky nav: solid + bordered once scrolled past the hero. */
function initNav() {
	const nav = document.querySelector('[data-nav]');
	if (!nav) return;
	const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 64);
	onScroll();
	window.addEventListener('scroll', onScroll, { passive: true });
}

/** Point every download CTA at the visitor's platform. */
function initOsCta(os: OS) {
	const cta = osCta(os);
	document.querySelectorAll<HTMLAnchorElement>('[data-os-cta]').forEach((anchor) => {
		anchor.href = cta.href;
		const label = anchor.querySelector('[data-os-cta-label]');
		if (label) label.textContent = cta.label;
		if (cta.external) {
			anchor.target = '_blank';
			anchor.rel = 'noopener noreferrer';
		} else {
			anchor.removeAttribute('target');
			anchor.removeAttribute('rel');
		}
	});
}

/** Promote the matching platform card on the download page. */
function initDownloadPromote(os: OS) {
	if (os === 'unknown') return;
	const card = document.querySelector<HTMLElement>(`[data-platform="${os}"]`);
	if (!card) return;
	card.classList.add('is-recommended');
	card.style.order = '-1';
	card.querySelector('[data-recommended-badge]')?.classList.remove('hidden');
}

const os = detectOS({ userAgent: navigator.userAgent, platform: navigator.platform });
initReveal();
initNav();
initOsCta(os);
initDownloadPromote(os);
