import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class lists, resolving Tailwind conflicts so the last wins. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
