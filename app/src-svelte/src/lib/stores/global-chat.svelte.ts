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
import type { BarExecution } from '$lib/bars/execution';
import { reduceGlobalChatStreamEvent, stopChatStream, type StreamOutcome } from '$lib/chat/stream';

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
	barId?: string;
	barTitle?: string;
	barPrompt?: string;
	barContext?: string;
}

function uid(): string {
	return crypto.randomUUID();
}

class GlobalChatStore {
	messages = $state<GlobalChatMessage[]>([]);
	draft = $state('');
	isStreaming = $state(false);
	streamOutcome = $state<StreamOutcome>('idle');
	#genId: string | null = null;

	async send(text?: string, execution?: BarExecution): Promise<void> {
		const question = (text ?? this.draft).trim();
		if (!question || this.isStreaming) return;

		this.draft = '';
		const history = this.messages.map((m) => ({ role: m.role, content: m.content }));
		const metadata = execution
			? {
					barId: execution.barId,
					barTitle: execution.barTitle,
					barPrompt: execution.barPrompt,
					barContext: execution.barContext,
				}
			: {};
		this.messages.push({ id: uid(), role: 'user', content: question, actions: [], ...metadata });
		this.messages.push({ id: uid(), role: 'assistant', content: '', actions: [], ...metadata });
		// Reactive proxy reference so action/token updates re-render.
		const assistant = this.messages[this.messages.length - 1]!;

		this.isStreaming = true;
		this.streamOutcome = 'streaming';
		const genId = uid();
		this.#genId = genId;

		const channel = new Channel<GlobalChatEvent>();
		channel.onmessage = (event) => {
			const state = {
				content: assistant.content,
				actions: assistant.actions,
				isStreaming: this.isStreaming,
				activeGenerationId: this.#genId,
				streamOutcome: this.streamOutcome,
			};
			const reduction = reduceGlobalChatStreamEvent(state, genId, event);
			if (reduction.state === state) return;
			assistant.content = reduction.state.content;
			assistant.actions = reduction.state.actions;
			this.isStreaming = reduction.state.isStreaming;
			this.#genId = reduction.state.activeGenerationId;
			this.streamOutcome = reduction.state.streamOutcome;
			if (reduction.error) toast.error('Chat failed', { description: reduction.error });
		};

		const { provider, model } = config.modelConfig;
		const res = await commands.globalChatAsk(question, history, provider, model, genId, channel);
		if (res.status === 'error' && this.#genId === genId) {
			if (!assistant.content) assistant.content = `⚠️ ${res.error}`;
			toast.error('Chat failed', { description: res.error });
			this.streamOutcome = 'error';
			this.#finish(genId);
		}
	}

	rerun(message: GlobalChatMessage): void {
		if (!message.barPrompt || !message.barId || !message.barTitle) return;
		void this.send(message.barPrompt, {
			barId: message.barId,
			barTitle: message.barTitle,
			barPrompt: message.barPrompt,
			barContext: message.barContext,
		});
	}

	stop(): void {
		// Same cancellation registry as the per-meeting chat.
		if (this.#genId) void commands.chatCancel(this.#genId);
		const stopped = stopChatStream({
			isStreaming: this.isStreaming,
			activeGenerationId: this.#genId,
			streamOutcome: this.streamOutcome,
		});
		this.isStreaming = stopped.isStreaming;
		this.#genId = stopped.activeGenerationId;
		this.streamOutcome = stopped.streamOutcome;
	}

	clear(): void {
		this.stop();
		this.messages = [];
		this.streamOutcome = 'idle';
	}

	#finish(genId: string): void {
		if (this.#genId !== genId) return;
		this.isStreaming = false;
		this.#genId = null;
	}
}

export const globalChat = new GlobalChatStore();
