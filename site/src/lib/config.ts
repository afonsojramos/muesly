// Centralized external URLs and constants used across the site.
export const SITE_URL = 'https://muesly.ai';
export const DOWNLOADS_URL = 'https://downloads.muesly.ai';
export const DOWNLOADS = {
	macos: `${DOWNLOADS_URL}/latest/muesly-macos-arm64.dmg`,
	windows: `${DOWNLOADS_URL}/latest/muesly-windows-x64-setup.exe`,
	linuxAppImage: `${DOWNLOADS_URL}/latest/muesly-linux-x86_64.AppImage`,
	linuxDeb: `${DOWNLOADS_URL}/latest/muesly-linux-x86_64.deb`,
	checksums: `${DOWNLOADS_URL}/latest/SHA256SUMS.txt`,
} as const;
