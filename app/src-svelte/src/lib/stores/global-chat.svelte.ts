/**
 * Global "ask your meetings" chat store.
 *
 * Drives the agentic backend (`global_chat_ask`): tool actions arrive as
 * progress steps attached to the in-flight assistant message (the ChatGPT-style
 * "Searching… / Reading…" pattern), then the answer streams token-by-token.
 * Session-scoped: the global thread is not persisted (unlike per-meeting chats).
 */

import { Channel } from '@tauri-apps/api/core';

import { commands, type GlobalChatEvent } from '$lib/bindings';
import { toast } from '$lib/toast';

import { config } from './config.svelte';

export interface GlobalChatAction {
	id: number;
	label: string;
	detail?: string;
	done: boolean;
}

export interface GlobalChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	/** The agent's visible tool steps (assistant messages only). */
	actions: GlobalChatAction[];
}

function uid(): string {
	return crypto.randomUUID();
}

class GlobalChatStore {
	messages = $state<GlobalChatMessage[]>([]);
	draft = $state('');
	isStreaming = $state(false);
	#genId: string | null = null;

	async send(text?: string): Promise<void> {
		const question = (text ?? this.draft).trim();
		if (!question || this.isStreaming) return;

		this.draft = '';
		const history = this.messages.map((m) => ({ role: m.role, content: m.content }));
		this.messages.push({ id: uid(), role: 'user', content: question, actions: [] });
		this.messages.push({ id: uid(), role: 'assistant', content: '', actions: [] });
		// Reactive proxy reference so action/token updates re-render.
		const assistant = this.messages[this.messages.length - 1]!;

		this.isStreaming = true;
		const genId = uid();
		this.#genId = genId;

		const channel = new Channel<GlobalChatEvent>();
		channel.onmessage = (event) => {
			if (this.#genId !== genId) return; // superseded
			switch (event.event) {
				case 'action':
					assistant.actions.push({ id: event.data.id, label: event.data.label, done: false });
					break;
				case 'action_done': {
					const action = assistant.actions.find((a) => a.id === event.data.id);
					if (action) {
						action.done = true;
						action.detail = event.data.detail;
					}
					break;
				}
				case 'token':
					assistant.content += event.data.text;
					break;
				case 'done':
					assistant.content = event.data.full;
					this.#finish(genId);
					break;
				case 'error':
					if (!assistant.content) assistant.content = `⚠️ ${event.data.message}`;
					toast.error('Chat failed', { description: event.data.message });
					this.#finish(genId);
					break;
			}
		};

		const { provider, model } = config.modelConfig;
		const res = await commands.globalChatAsk(question, history, provider, model, genId, channel);
		if (res.status === 'error' && this.#genId === genId) {
			if (!assistant.content) assistant.content = `⚠️ ${res.error}`;
			toast.error('Chat failed', { description: res.error });
			this.#finish(genId);
		}
	}

	stop(): void {
		// Same cancellation registry as the per-meeting chat.
		if (this.#genId) void commands.chatCancel(this.#genId);
		this.isStreaming = false;
		this.#genId = null;
	}

	clear(): void {
		this.stop();
		this.messages = [];
	}

	#finish(genId: string): void {
		if (this.#genId !== genId) return;
		this.isStreaming = false;
		this.#genId = null;
	}
}

export const globalChat = new GlobalChatStore();
