/**
 * Folder context store ("folder memory").
 *
 * User-curated items (notes, glossary, preferences, decisions) attached to a
 * sidebar folder, plus the accept/reject queue for memories proposed by the
 * post-summary extraction pass. Prompt injection happens entirely in Rust;
 * this store only mirrors the data for the folder page and listens for the
 * `folder-memory-proposed` event (a global Tauri event, owned here so it
 * outlives any view).
 */

import { listen } from '@tauri-apps/api/event';

import {
	commands,
	type FolderContextInput,
	type FolderContextItem,
	type FolderContextToggles,
} from '$lib/bindings';
import { toast } from '$lib/toast';

export const FOLDER_CONTEXT_KINDS = ['note', 'glossary', 'preference', 'decision'] as const;
export type FolderContextKind = (typeof FOLDER_CONTEXT_KINDS)[number];

class FolderContextStore {
	items = $state<Record<string, FolderContextItem[]>>({});
	toggles = $state<Record<string, FolderContextToggles>>({});
	#listening = false;

	#ensureListener(): void {
		if (this.#listening) return;
		this.#listening = true;
		void listen<{ folder_id: string; count: number }>('folder-memory-proposed', (event) => {
			const folderId = event.payload.folder_id;
			void this.load(folderId);
			toast.info(
				`Learned ${event.payload.count} new ${event.payload.count === 1 ? 'memory' : 'memories'}`,
				{ description: 'See them in the folder’s Memory section.' },
			);
		});
	}

	async load(folderId: string): Promise<void> {
		this.#ensureListener();
		const [items, toggles] = await Promise.all([
			commands.apiListFolderContext(folderId),
			commands.apiGetFolderContextToggles(folderId),
		]);
		if (items.status === 'error') {
			toast.error('Failed to load folder memory', { description: items.error });
			return;
		}
		this.items[folderId] = items.data;
		if (toggles.status === 'ok') this.toggles[folderId] = toggles.data;
	}

	async save(input: FolderContextInput): Promise<boolean> {
		const res = await commands.apiSaveFolderContextItem(input);
		if (res.status === 'error') {
			toast.error('Failed to save memory', { description: res.error });
			return false;
		}
		await this.load(input.folder_id);
		return true;
	}

	async remove(folderId: string, id: string): Promise<void> {
		const res = await commands.apiDeleteFolderContextItem(id);
		if (res.status === 'error') {
			toast.error('Failed to delete memory', { description: res.error });
			return;
		}
		await this.load(folderId);
	}

	async accept(folderId: string, id: string): Promise<void> {
		const res = await commands.apiAcceptFolderMemory(id);
		if (res.status === 'error') {
			toast.error('Failed to accept memory', { description: res.error });
			return;
		}
		await this.load(folderId);
	}

	async reject(folderId: string, id: string): Promise<void> {
		const res = await commands.apiRejectFolderMemory(id);
		if (res.status === 'error') {
			toast.error('Failed to reject memory', { description: res.error });
			return;
		}
		await this.load(folderId);
	}

	async setInSummaries(folderId: string, enabled: boolean): Promise<void> {
		const res = await commands.apiSetFolderContextInSummaries(folderId, enabled);
		if (res.status === 'error') {
			toast.error('Failed to update folder setting', { description: res.error });
			return;
		}
		const current = this.toggles[folderId];
		this.toggles[folderId] = {
			context_in_summaries: enabled,
			memory_extraction: current?.memory_extraction ?? false,
		};
	}

	async setExtraction(folderId: string, enabled: boolean): Promise<void> {
		const res = await commands.apiSetFolderMemoryExtraction(folderId, enabled);
		if (res.status === 'error') {
			toast.error('Failed to update folder setting', { description: res.error });
			return;
		}
		const current = this.toggles[folderId];
		this.toggles[folderId] = {
			context_in_summaries: current?.context_in_summaries ?? false,
			memory_extraction: enabled,
		};
	}

	pendingFor(folderId: string): FolderContextItem[] {
		return (this.items[folderId] ?? []).filter((item) => item.status === 'pending');
	}

	acceptedFor(folderId: string): FolderContextItem[] {
		return (this.items[folderId] ?? []).filter((item) => item.status === 'accepted');
	}
}

export const folderContext = new FolderContextStore();
