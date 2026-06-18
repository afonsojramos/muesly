/**
 * Toast abstraction.
 *
 * Stores call into this module instead of importing a UI library directly.
 * The actual toaster (Ark UI Toast) is wired in the root layout once Phase 5
 * (UI primitives) is built. Until then, this falls back to console output so
 * stores can be developed and tested independently of the UI layer.
 */

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastOptions {
	description?: string;
	duration?: number;
	action?: ToastAction;
}

export interface ToastImpl {
	success(message: string, options?: ToastOptions): void;
	error(message: string, options?: ToastOptions): void;
	info?(message: string, options?: ToastOptions): void;
}

let impl: ToastImpl = {
	success(message, options) {
		console.log('[toast.success]', message, options ?? '');
	},
	error(message, options) {
		console.error('[toast.error]', message, options ?? '');
	},
	info(message, options) {
		console.info('[toast.info]', message, options ?? '');
	}
};

/**
 * Register the real toaster implementation. Called once from the root layout
 * after the Ark UI Toaster is mounted.
 */
export function setToastImpl(next: ToastImpl): void {
	impl = next;
}

export const toast = {
	success(message: string, options?: ToastOptions): void {
		impl.success(message, options);
	},
	error(message: string, options?: ToastOptions): void {
		impl.error(message, options);
	},
	info(message: string, options?: ToastOptions): void {
		impl.info?.(message, options);
	}
};
