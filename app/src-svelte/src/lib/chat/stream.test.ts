import { describe, expect, it } from 'vitest';

import {
	reduceChatStreamEvent,
	reduceGlobalChatStreamEvent,
	type ChatStreamState,
	type GlobalChatStreamState,
} from './stream';

const streaming = (content = ''): ChatStreamState => ({
	content,
	isStreaming: true,
	activeGenerationId: 'current',
});

describe('reduceChatStreamEvent', () => {
	it('appends incremental tokens', () => {
		const reduction = reduceChatStreamEvent(streaming('Hello'), 'current', {
			event: 'token',
			data: { text: ' world' },
		});

		expect(reduction.state.content).toBe('Hello world');
		expect(reduction.state.isStreaming).toBe(true);
	});

	it('uses done.full as the authoritative answer', () => {
		const reduction = reduceChatStreamEvent(streaming('partial answer'), 'current', {
			event: 'done',
			data: { gen_id: 'current', full: 'complete answer' },
		});

		expect(reduction.state).toEqual({
			content: 'complete answer',
			isStreaming: false,
			activeGenerationId: null,
		});
	});

	it('rejects stale generations without mutating their message', () => {
		const state = streaming('new answer');
		const reduction = reduceChatStreamEvent(state, 'stale', {
			event: 'token',
			data: { text: ' stale token' },
		});

		expect(reduction.state).toBe(state);
		expect(state.content).toBe('new answer');
	});

	it('preserves streamed content when an error follows it', () => {
		const reduction = reduceChatStreamEvent(streaming('useful partial answer'), 'current', {
			event: 'error',
			data: { message: 'connection lost' },
		});

		expect(reduction.state.content).toBe('useful partial answer');
		expect(reduction.state.isStreaming).toBe(false);
		expect(reduction.error).toBe('connection lost');
	});

	it('shows an error in an otherwise empty answer', () => {
		const reduction = reduceChatStreamEvent(streaming(), 'current', {
			event: 'error',
			data: { message: 'model unavailable' },
		});

		expect(reduction.state.content).toBe('⚠️ model unavailable');
	});
});

describe('reduceGlobalChatStreamEvent', () => {
	it('characterizes progress actions and final answer streaming', () => {
		const initial: GlobalChatStreamState = { ...streaming(), actions: [] };
		const action = reduceGlobalChatStreamEvent(initial, 'current', {
			event: 'action',
			data: { id: 4, label: 'Searching' },
		}).state;
		const completed = reduceGlobalChatStreamEvent(action, 'current', {
			event: 'action_done',
			data: { id: 4, detail: '3 meetings' },
		}).state;
		const done = reduceGlobalChatStreamEvent(completed, 'current', {
			event: 'done',
			data: { gen_id: 'current', full: 'The final answer' },
		}).state;

		expect(completed.actions).toEqual([
			{ id: 4, label: 'Searching', done: true, detail: '3 meetings' },
		]);
		expect(done.content).toBe('The final answer');
		expect(done.isStreaming).toBe(false);
	});
});
