/**
 * Toast abstraction.
 *
 * Stores and components call into this module instead of importing a UI library
 * directly. Internally it forwards to `svelte-sonner`'s `toast`, which the
 * shadcn `<Sonner />` Toaster (mounted once in the app layout) renders. Keeping
 * the indirection means call sites never depend on the toast UI implementation.
 */

import { toast as sonner } from 'svelte-sonner';

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastOptions {
	description?: string;
	duration?: number;
	action?: ToastAction;
	/** Re-issuing with the same id updates that toast in place. */
	id?: string | number;
}

export interface ToastImpl {
	success(message: string, options?: ToastOptions): void;
	error(message: string, options?: ToastOptions): void;
	info?(message: string, options?: ToastOptions): void;
}

/** Map our option shape onto sonner's ExternalToast options. */
function toSonner(options?: ToastOptions) {
	if (!options) return undefined;
	return {
		description: options.description,
		duration: options.duration,
		action: options.action
			? { label: options.action.label, onClick: options.action.onClick }
			: undefined,
		id: options.id,
	};
}

/**
 * Retained for backward compatibility. The toaster used to register its
 * implementation here at mount time; svelte-sonner needs no registration, so
 * this is now a no-op.
 *
 * @deprecated The toast implementation forwards to svelte-sonner directly.
 */
export function setToastImpl(_next: ToastImpl): void {
	// Intentionally empty: svelte-sonner is wired statically.
}

export const toast = {
	success(message: string, options?: ToastOptions): void {
		sonner.success(message, toSonner(options));
	},
	error(message: string, options?: ToastOptions): void {
		sonner.error(message, toSonner(options));
	},
	info(message: string, options?: ToastOptions): void {
		sonner.info(message, toSonner(options));
	},
	/** A spinner toast that persists until dismissed (or updated via `id`). */
	loading(message: string, options?: ToastOptions): string | number {
		return sonner.loading(message, toSonner(options));
	},
	dismiss(id: string | number): void {
		sonner.dismiss(id);
	},
};
