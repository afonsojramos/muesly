/**
 * "Ask anything" chat store.
 *
 * Holds the ephemeral per-session conversation about the current meeting and
 * drives a streaming answer from Rust over a Tauri `Channel`. Tokens append to
 * the in-flight assistant message; a hand-rolled runes store (not
 * `@tanstack/ai-svelte`) keeps deps at zero and the message shape ours.
 */

import { Channel } from '@tauri-apps/api/core';

import { commands, type ChatStreamEvent } from '$lib/bindings';
import { formatTranscriptForLlm } from '$lib/format-transcript-for-llm';
import { toast } from '$lib/toast';

import { config } from './config.svelte';
import { recordingState, RecordingStatus } from './recording-state.svelte';
import { sidebar } from './sidebar.svelte';
import { transcripts } from './transcript.svelte';

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
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
		return transcripts.currentMeetingId ?? sidebar.currentMeeting?.id ?? null;
	}

	async send(text?: string): Promise<void> {
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
		this.messages.push({ id: uid(), role: 'user', content: question });
		this.messages.push({ id: uid(), role: 'assistant', content: '' });
		// Reference the reactive proxy so token appends re-render (just pushed above).
		const assistant = this.messages[this.messages.length - 1]!;

		this.isStreaming = true;
		const genId = uid();
		this.#genId = genId;

		const channel = new Channel<ChatStreamEvent>();
		channel.onmessage = (event) => {
			if (this.#genId !== genId) return; // a newer ask superseded this one
			switch (event.event) {
				case 'token':
					assistant.content += event.data.text;
					break;
				case 'done':
					// Authoritative + idempotent: reconciles any dropped token once
					// real streaming lands (Phase 1 sends the whole answer as one token).
					assistant.content = event.data.full;
					this.#finish(genId);
					break;
				case 'error':
					this.#fail(genId, assistant, event.data.message);
					break;
			}
		};

		// During a live recording the meeting id is ephemeral (IndexedDB only);
		// pass the on-screen transcript so chat is not empty until save.
		// Live recording (including paused) uses an ephemeral meeting id that
		// is not in SQLite yet — send the on-screen transcript instead.
		const isLive =
			recordingState.isRecording ||
			recordingState.status === RecordingStatus.RECORDING;
		const liveTranscript = isLive
			? formatTranscriptForLlm(transcripts.transcripts)
			: null;

		// Backend `chat_ask(model, modelName)`: `model` is the provider kind
		// (e.g. "ollama"/"builtin-ai"), `modelName` the concrete model id.
		const { provider, model } = config.modelConfig;
		const res = await commands.chatAsk(
			meetingId,
			question,
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

	stop(): void {
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

	#fail(genId: string, assistant: ChatMessage, message: string): void {
		if (this.#genId !== genId) return;
		if (!assistant.content) assistant.content = `⚠️ ${message}`;
		toast.error('Chat failed', { description: message });
		this.#finish(genId);
	}
}

export const chat = new ChatStore();
