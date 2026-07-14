import type { ChatStreamEvent, GlobalChatEvent } from '$lib/bindings';

export type StreamOutcome = 'idle' | 'streaming' | 'completed' | 'error' | 'cancelled';

export interface StreamLifecycleState {
	isStreaming: boolean;
	activeGenerationId: string | null;
	streamOutcome: StreamOutcome;
}

export interface ChatStreamState extends StreamLifecycleState {
	content: string;
}

export interface GlobalChatStreamState extends ChatStreamState {
	actions: { id: number; label: string; detail?: string; done: boolean }[];
}

export interface StreamReduction<T> {
	state: T;
	error?: string;
}

export function getStreamAnnouncement(outcome: StreamOutcome): string {
	switch (outcome) {
		case 'streaming':
			return 'Thinking';
		case 'completed':
			return 'Response ready';
		case 'error':
			return 'Response failed';
		case 'idle':
		case 'cancelled':
			return '';
	}
}

export function stopChatStream<T extends StreamLifecycleState>(state: T): T {
	if (!state.activeGenerationId) return state;
	return {
		...state,
		isStreaming: false,
		activeGenerationId: null,
		streamOutcome: 'cancelled',
	};
}

export type ChatClearResult = { status: 'ok' } | { status: 'error'; error: string };

export class ChatClearCoordinator<T> {
	isClearing = false;
	loadGeneration = 0;

	invalidateLoads(): number {
		return ++this.loadGeneration;
	}

	async run(
		messages: T[],
		cancel: () => void,
		clearBackend: () => Promise<ChatClearResult>,
	): Promise<{ status: 'ignored' | 'ok' | 'error'; messages: T[]; error?: string }> {
		if (this.isClearing) return { status: 'ignored', messages };

		this.isClearing = true;
		this.invalidateLoads();
		const snapshot = [...messages];
		cancel();

		const result = await clearBackend();
		this.isClearing = false;
		if (result.status === 'error') {
			return { status: 'error', messages: snapshot, error: result.error };
		}
		return { status: 'ok', messages: [] };
	}
}

export function reduceChatStreamEvent(
	state: ChatStreamState,
	generationId: string,
	event: ChatStreamEvent,
): StreamReduction<ChatStreamState> {
	if (state.activeGenerationId !== generationId) return { state };

	switch (event.event) {
		case 'token':
			return { state: { ...state, content: state.content + event.data.text } };
		case 'done':
			return {
				state: {
					content: event.data.full,
					isStreaming: false,
					activeGenerationId: null,
					streamOutcome: 'completed',
				},
			};
		case 'error':
			return {
				state: {
					content: state.content || `⚠️ ${event.data.message}`,
					isStreaming: false,
					activeGenerationId: null,
					streamOutcome: 'error',
				},
				error: event.data.message,
			};
		case 'started':
			return { state };
	}
}

export function reduceGlobalChatStreamEvent(
	state: GlobalChatStreamState,
	generationId: string,
	event: GlobalChatEvent,
): StreamReduction<GlobalChatStreamState> {
	if (state.activeGenerationId !== generationId) return { state };

	switch (event.event) {
		case 'action':
			return {
				state: {
					...state,
					actions: [...state.actions, { id: event.data.id, label: event.data.label, done: false }],
				},
			};
		case 'action_done':
			return {
				state: {
					...state,
					actions: state.actions.map((action) =>
						action.id === event.data.id
							? { ...action, done: true, detail: event.data.detail }
							: action,
					),
				},
			};
		case 'token':
			return { state: { ...state, content: state.content + event.data.text } };
		case 'done':
			return {
				state: {
					...state,
					content: event.data.full,
					isStreaming: false,
					activeGenerationId: null,
					streamOutcome: 'completed',
				},
			};
		case 'error':
			return {
				state: {
					...state,
					content: state.content || `⚠️ ${event.data.message}`,
					isStreaming: false,
					activeGenerationId: null,
					streamOutcome: 'error',
				},
				error: event.data.message,
			};
		case 'started':
			return { state };
	}
}
