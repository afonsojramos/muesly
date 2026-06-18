/**
 * Import dialog store.
 *
 * Components register their onOpen handler at mount time and other components
 * call `openImportDialog(path)` to trigger it.
 *
 * Equivalent of the React ImportDialogProvider.
 */

type OpenHandler = (filePath?: string | null) => void;

class ImportDialogStore {
	#onOpen: OpenHandler | null = null;

	/** Register the dialog's open handler. Returns a cleanup function. */
	register(handler: OpenHandler): () => void {
		this.#onOpen = handler;
		return () => {
			if (this.#onOpen === handler) {
				this.#onOpen = null;
			}
		};
	}

	openImportDialog(filePath?: string | null): void {
		if (!this.#onOpen) {
			console.warn('[ImportDialogStore] openImportDialog called before any handler registered');
			return;
		}

		this.#onOpen(filePath);
	}
}

export const importDialog = new ImportDialogStore();
