import { describe, expect, it } from 'vitest';

import {
	getStreamAnnouncement,
	ChatClearCoordinator,
	reduceChatStreamEvent,
	reduceGlobalChatStreamEvent,
	stopChatStream,
	type ChatStreamState,
	type GlobalChatStreamState,
} from './stream';

describe('ChatClearCoordinator', () => {
	it('cancels first and empties the thread once after backend success', async () => {
		const coordinator = new ChatClearCoordinator<string>();
		const order: string[] = [];
		const result = await coordinator.run(
			['question', 'answer'],
			() => order.push('cancel'),
			async () => {
				order.push('backend');
				return { status: 'ok' };
			},
		);

		expect(order).toEqual(['cancel', 'backend']);
		expect(result).toEqual({ status: 'ok', messages: [] });
		expect(coordinator.isClearing).toBe(false);
	});

	it('restores the exact snapshot when backend clearing fails', async () => {
		const coordinator = new ChatClearCoordinator<{ id: string }>();
		const messages = [{ id: 'user' }, { id: 'assistant' }];
		const result = await coordinator.run(
			messages,
			() => {},
			async () => ({
				status: 'error',
				error: 'database busy',
			}),
		);

		expect(result.status).toBe('error');
		expect(result.messages).toEqual(messages);
		expect(result.messages[0]).toBe(messages[0]);
	});

	it('ignores a double submit while clearing', async () => {
		const coordinator = new ChatClearCoordinator<string>();
		let finish!: (result: { status: 'ok' }) => void;
		let backendCalls = 0;
		const first = coordinator.run(
			['thread'],
			() => {},
			() => {
				backendCalls += 1;
				return new Promise((resolve) => (finish = resolve));
			},
		);
		const second = await coordinator.run(
			['thread'],
			() => {},
			async () => {
				backendCalls += 1;
				return { status: 'ok' };
			},
		);

		expect(second.status).toBe('ignored');
		expect(backendCalls).toBe(1);
		finish({ status: 'ok' });
		await first;
	});

	it('invalidates a stale load as soon as clearing starts', async () => {
		const coordinator = new ChatClearCoordinator<string>();
		const loadGeneration = coordinator.invalidateLoads();
		const clearing = coordinator.run(
			['thread'],
			() => {},
			async () => ({ status: 'ok' }),
		);

		expect(loadGeneration).not.toBe(coordinator.loadGeneration);
		await clearing;
	});
});

const streaming = (content = ''): ChatStreamState => ({
	content,
	isStreaming: true,
	activeGenerationId: 'current',
	streamOutcome: 'streaming',
});

describe('reduceChatStreamEvent', () => {
	it('appends incremental tokens', () => {
		const reduction = reduceChatStreamEvent(streaming('Hello'), 'current', {
			event: 'token',
			data: { text: ' world' },
		});

		expect(reduction.state.content).toBe('Hello world');
		expect(reduction.state.isStreaming).toBe(true);
		expect(reduction.state.streamOutcome).toBe('streaming');
		expect(getStreamAnnouncement(reduction.state.streamOutcome)).toBe('Thinking');
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
			streamOutcome: 'completed',
		});
		expect(getStreamAnnouncement(reduction.state.streamOutcome)).toBe('Response ready');
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
		expect(reduction.state.streamOutcome).toBe('error');
		expect(getStreamAnnouncement(reduction.state.streamOutcome)).toBe('Response failed');
	});

	it('shows an error in an otherwise empty answer', () => {
		const reduction = reduceChatStreamEvent(streaming(), 'current', {
			event: 'error',
			data: { message: 'model unavailable' },
		});

		expect(reduction.state.content).toBe('⚠️ model unavailable');
	});
});

describe('getStreamAnnouncement', () => {
	it('announces only active work and meaningful terminal outcomes', () => {
		expect(getStreamAnnouncement('idle')).toBe('');
		expect(getStreamAnnouncement('streaming')).toBe('Thinking');
		expect(getStreamAnnouncement('completed')).toBe('Response ready');
		expect(getStreamAnnouncement('error')).toBe('Response failed');
		expect(getStreamAnnouncement('cancelled')).toBe('');
	});
});

describe('stopChatStream', () => {
	it('transitions an active stream to cancelled', () => {
		const stopped = stopChatStream(streaming('partial answer'));

		expect(stopped).toEqual({
			content: 'partial answer',
			isStreaming: false,
			activeGenerationId: null,
			streamOutcome: 'cancelled',
		});
		expect(getStreamAnnouncement(stopped.streamOutcome)).toBe('');
	});

	it('preserves an inactive terminal outcome', () => {
		const completed: ChatStreamState = {
			content: 'complete answer',
			isStreaming: false,
			activeGenerationId: null,
			streamOutcome: 'completed',
		};

		expect(stopChatStream(completed)).toBe(completed);
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
