import type { ChatStreamEvent, GlobalChatEvent } from '$lib/bindings';

export interface ChatStreamState {
	content: string;
	isStreaming: boolean;
	activeGenerationId: string | null;
}

export interface GlobalChatStreamState extends ChatStreamState {
	actions: { id: number; label: string; detail?: string; done: boolean }[];
}

export interface StreamReduction<T> {
	state: T;
	error?: string;
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
				state: { content: event.data.full, isStreaming: false, activeGenerationId: null },
			};
		case 'error':
			return {
				state: {
					content: state.content || `⚠️ ${event.data.message}`,
					isStreaming: false,
					activeGenerationId: null,
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
				},
			};
		case 'error':
			return {
				state: {
					...state,
					content: state.content || `⚠️ ${event.data.message}`,
					isStreaming: false,
					activeGenerationId: null,
				},
				error: event.data.message,
			};
		case 'started':
			return { state };
	}
}
