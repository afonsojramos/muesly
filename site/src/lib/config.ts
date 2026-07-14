// Centralized external URLs and constants used across the site.
export const SITE_URL = 'https://muesly.ai';
export const GITHUB_URL = 'https://github.com/afonsojramos/muesly';
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`;
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;
export const DOWNLOADS_URL = `${GITHUB_RELEASES_URL}/latest/download`;
export const DOWNLOADS = {
	macos: `${DOWNLOADS_URL}/muesly-macos-arm64.dmg`,
	windows: `${DOWNLOADS_URL}/muesly-windows-x64-setup.exe`,
	linuxAppImage: `${DOWNLOADS_URL}/muesly-linux-x86_64.AppImage`,
	linuxDeb: `${DOWNLOADS_URL}/muesly-linux-x86_64.deb`,
	checksums: `${DOWNLOADS_URL}/SHA256SUMS.txt`,
} as const;
