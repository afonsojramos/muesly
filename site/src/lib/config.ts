// Centralized external URLs and constants used across the site.
export const SITE_URL = 'https://muesly.ai';
export const GITHUB_URL = 'https://github.com/afonsojramos/muesly';
export const RELEASES_URL = `${GITHUB_URL}/releases/latest`;
export const RELEASES_PAGE = `${GITHUB_URL}/releases`;
export const BUILD_GUIDE_URL = `${GITHUB_URL}/blob/main/docs/building.md`;
export const DOWNLOADS = {
	macos: `${GITHUB_URL}/releases/latest/download/muesly-macos-arm64.dmg`,
	windows: `${GITHUB_URL}/releases/latest/download/muesly-windows-x64-setup.exe`,
	linuxAppImage: `${GITHUB_URL}/releases/latest/download/muesly-linux-x86_64.AppImage`,
	linuxDeb: `${GITHUB_URL}/releases/latest/download/muesly-linux-x86_64.deb`,
	checksums: `${GITHUB_URL}/releases/latest/download/SHA256SUMS.txt`,
} as const;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE.md`;
