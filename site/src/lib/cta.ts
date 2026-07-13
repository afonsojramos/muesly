import { DOWNLOADS } from './config';
import type { OS } from './utils/detect-os';

export type Cta = { label: string; href: string; external: boolean };

/** Primary download call-to-action for a detected platform. */
export function osCta(os: OS): Cta {
	switch (os) {
		case 'macos':
			return { label: 'Download for Mac', href: DOWNLOADS.macos, external: true };
		case 'windows':
			return { label: 'Download for Windows', href: DOWNLOADS.windows, external: true };
		case 'linux':
			return { label: 'Download for Linux', href: DOWNLOADS.linuxAppImage, external: true };
		default:
			return { label: 'See all downloads', href: '/download', external: false };
	}
}
