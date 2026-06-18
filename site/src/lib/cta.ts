import { BUILD_GUIDE_URL, RELEASES_URL } from './config';
import type { OS } from './utils/detect-os';

export type Cta = { label: string; href: string; external: boolean };

/** Primary download call-to-action for a detected platform. */
export function osCta(os: OS): Cta {
	switch (os) {
		case 'macos':
			return { label: 'Download for Mac', href: RELEASES_URL, external: true };
		case 'windows':
			return { label: 'Download for Windows', href: RELEASES_URL, external: true };
		case 'linux':
			return { label: 'Build from source', href: BUILD_GUIDE_URL, external: true };
		default:
			return { label: 'See all downloads', href: '/download', external: false };
	}
}
