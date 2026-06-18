import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names with conflict resolution.
 * Use throughout the app for conditional / variant-driven classes.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

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
		'econnrefused'
	];

	return patterns.some((pattern) => lower.includes(pattern));
}
