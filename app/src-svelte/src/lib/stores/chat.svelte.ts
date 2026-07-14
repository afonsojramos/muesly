/**
 * "Ask anything" chat store.
 *
 * Holds the ephemeral per-session conversation about the current meeting and
 * drives a streaming answer from Rust over a Tauri `Channel`. Tokens append to
 * the in-flight assistant message; a hand-rolled runes store (not
 * `@tanstack/ai-svelte`) keeps deps at zero and the message shape ours.
 */

import { Channel } from '@tauri-apps/api/core';

import { commands, type ChatStreamEvent, type RecentChatThread } from '$lib/bindings';
import { formatTranscriptForLlm } from '$lib/format-transcript-for-llm';
import { toast } from '$lib/toast';
import type { BarExecution } from '$lib/bars/execution';
import { reduceChatStreamEvent } from '$lib/chat/stream';

import { config } from './config.svelte';
import { recordingState, RecordingStatus } from './recording-state.svelte';
import { sidebar } from './sidebar.svelte';
import { transcripts } from './transcript.svelte';

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	barId?: string;
	barTitle?: string;
	barPrompt?: string;
	barContext?: string;
}

function uid(): string {
	return crypto.randomUUID();
}

class ChatStore {
	messages = $state<ChatMessage[]>([]);
	draft = $state('');
	isStreaming = $state(false);
	#genId: string | null = null;

	/** The meeting the chat is about: the live recording, else the opened saved meeting. */
	get meetingId(): string | null {
		const liveStatus =
			recordingState.isRecording ||
			recordingState.status === RecordingStatus.STARTING ||
			recordingState.status === RecordingStatus.RECORDING ||
			recordingState.status === RecordingStatus.STOPPING ||
			recordingState.status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
			recordingState.status === RecordingStatus.SAVING;
		if (liveStatus && transcripts.currentMeetingId) return transcripts.currentMeetingId;
		return sidebar.currentMeeting?.id ?? transcripts.currentMeetingId ?? null;
	}

	async send(text?: string, execution?: BarExecution): Promise<void> {
		const question = (text ?? this.draft).trim();
		if (!question || this.isStreaming) return;

		const meetingId = this.meetingId;
		if (!meetingId) {
			toast.error('No meeting to ask about yet');
			return;
		}

		this.draft = '';
		// History is the prior turns only; the new question is sent separately.
		const history = this.messages.map((m) => ({ role: m.role, content: m.content }));
		const metadata = execution
			? {
					barId: execution.barId,
					barTitle: execution.barTitle,
					barPrompt: execution.barPrompt,
					barContext: execution.barContext,
				}
			: {};
		this.messages.push({ id: uid(), role: 'user', content: question, ...metadata });
		this.messages.push({ id: uid(), role: 'assistant', content: '', ...metadata });
		// Reference the reactive proxy so token appends re-render (just pushed above).
		const assistant = this.messages[this.messages.length - 1]!;

		this.isStreaming = true;
		const genId = uid();
		this.#genId = genId;

		const channel = new Channel<ChatStreamEvent>();
		channel.onmessage = (event) => {
			const state = {
				content: assistant.content,
				isStreaming: this.isStreaming,
				activeGenerationId: this.#genId,
			};
			const reduction = reduceChatStreamEvent(state, genId, event);
			if (reduction.state === state) return;
			assistant.content = reduction.state.content;
			this.isStreaming = reduction.state.isStreaming;
			this.#genId = reduction.state.activeGenerationId;
			if (reduction.error) toast.error('Chat failed', { description: reduction.error });
		};

		// During a live recording the meeting id is ephemeral (IndexedDB only);
		// pass the on-screen transcript so chat is not empty until save.
		// Live recording (including paused) uses an ephemeral meeting id that
		// is not in SQLite yet — send the on-screen transcript instead.
		const isLive =
			recordingState.isRecording || recordingState.status === RecordingStatus.RECORDING;
		const liveTranscript = isLive ? formatTranscriptForLlm(transcripts.transcripts) : null;

		// Backend `chat_ask(model, modelName)`: `model` is the provider kind
		// (e.g. "ollama"/"builtin-ai"), `modelName` the concrete model id.
		const { provider, model } = config.modelConfig;
		const res = await commands.chatAsk(
			meetingId,
			{
				content: question,
				bar_id: execution?.barId ?? null,
				display_text: execution?.barTitle ?? null,
				bar_context: execution?.barContext ?? null,
			},
			history,
			provider,
			model,
			genId,
			liveTranscript,
			channel,
		);
		// A command-level rejection (e.g. missing settings) never emits an Error event.
		if (res.status === 'error' && this.#genId === genId) {
			this.#fail(genId, assistant, res.error);
		}
	}

	rerun(message: ChatMessage): void {
		if (!message.barPrompt || !message.barId || !message.barTitle) return;
		void this.send(message.barPrompt, {
			barId: message.barId,
			barTitle: message.barTitle,
			barPrompt: message.barPrompt,
			barContext: message.barContext,
		});
	}

	stop(): void {
		if (this.#genId) void commands.chatCancel(this.#genId);
		this.isStreaming = false;
		this.#genId = null;
	}

	clear(): void {
		this.stop();
		this.messages = [];
	}

	// Monotonic token so a slow history load can't clobber a newer meeting's
	// thread (same guard pattern as use-speaker-context).
	#loadGen = 0;

	/** Replace the conversation with the meeting's persisted thread. Completed
	 * turns are persisted backend-side, so collapse/navigation never loses them;
	 * an in-flight stream is cancelled since it belongs to the previous view. */
	async loadFor(meetingId: string | null): Promise<void> {
		this.#loadGen += 1;
		const gen = this.#loadGen;
		this.clear();
		if (!meetingId) return;
		const res = await commands.chatHistory(meetingId);
		if (gen !== this.#loadGen || res.status !== 'ok') return;
		const rows = res.data.filter((m) => m.role === 'user' || m.role === 'assistant');
		this.messages = rows.map((m, index) => {
			const prompt = m.role === 'user' ? m.content : rows[index - 1]?.content;
			return {
				id: m.id,
				role: m.role as 'user' | 'assistant',
				content: m.content,
				barId: m.bar_id ?? undefined,
				barTitle: m.display_text ?? undefined,
				barPrompt: m.bar_id ? prompt : undefined,
				barContext: m.bar_context ?? undefined,
			};
		});
	}

	/** Delete the conversation, in memory and persisted. */
	async clearThread(): Promise<void> {
		const meetingId = this.meetingId;
		this.#loadGen += 1; // invalidate any in-flight load
		this.clear();
		if (!meetingId) return;
		const res = await commands.chatClear(meetingId);
		if (res.status === 'error') {
			toast.error('Failed to clear chat', { description: res.error });
		}
	}

	/** Recent chat threads across meetings, for the "Recent chats" list. */
	async recentThreads(): Promise<RecentChatThread[]> {
		const res = await commands.chatRecent();
		return res.status === 'ok' ? res.data : [];
	}

	#finish(genId: string): void {
		if (this.#genId !== genId) return;
		this.isStreaming = false;
		this.#genId = null;
	}

	#fail(genId: string, assistant: ChatMessage, message: string): void {
		if (this.#genId !== genId) return;
		if (!assistant.content) assistant.content = `⚠️ ${message}`;
		toast.error('Chat failed', { description: message });
		this.#finish(genId);
	}
}

export const chat = new ChatStore();
