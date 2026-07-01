// Tailwind class merger with conflict resolution. cnfast is a drop-in for the
// clsx + tailwind-merge `cn` pattern (byte-identical output, ~3.8x faster). Use
// `cn()` throughout the app for conditional / variant-driven classes.
export { cn } from 'cnfast';

// Helper types consumed by the generated shadcn-svelte (bits-ui) components in
// `$lib/components/ui`. Pure type aliases — zero runtime, no bearing on `cn`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
	ref?: U | null;
};

/**
 * Detects whether an error string indicates Ollama is not installed or not running.
 */
export function isOllamaNotInstalledError(errorMessage: string): boolean {
	if (!errorMessage) return false;

	const lower = errorMessage.toLowerCase();
	const patterns = [
		'cannot connect',
		'connection refused',
		'cli not found',
		'not in path',
		'ollama cli not found',
		'not found or not in path',
		'please check if the server is running',
		'please check if the ollama server is running',
		'econnrefused',
	];

	return patterns.some((pattern) => lower.includes(pattern));
}
