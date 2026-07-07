import { describe, it, expect } from 'vitest';
import { groupPreviewEventsByDay, formatEventTime } from './coming-up';
import type { PreviewEvent } from './bindings';

function ev(start: string, title = 'Event'): PreviewEvent {
	return {
		title,
		start,
		end: null,
		source: 'eventkit',
		calendar_name: null,
		ical_uid: null,
		occurrence_minute: 0,
		is_recurring: false,
		conference_url: null,
	};
}

describe('groupPreviewEventsByDay', () => {
	const now = new Date('2026-07-06T09:00:00');

	it('buckets by day, ascending, with today flagged', () => {
		const groups = groupPreviewEventsByDay(
			[
				ev('2026-07-07T10:30:00', 'Standup'),
				ev('2026-07-06T12:00:00', 'Catchup'),
				ev('2026-07-06T14:30:00', 'Refinement'),
			],
			now,
		);
		expect(groups.map((g) => g.day)).toEqual([6, 7]);
		expect(groups[0]?.isToday).toBe(true);
		expect(groups[1]?.isToday).toBe(false);
		// Within a day, sorted soonest-first.
		expect(groups[0]?.items.map((e) => e.title)).toEqual(['Catchup', 'Refinement']);
	});

	it('skips unparseable dates and returns empty for no events', () => {
		expect(groupPreviewEventsByDay([ev('not-a-date')], now)).toEqual([]);
		expect(groupPreviewEventsByDay([], now)).toEqual([]);
	});

	it('drops events that have already started', () => {
		const groups = groupPreviewEventsByDay(
			[ev('2026-07-06T08:00:00', 'Past'), ev('2026-07-06T12:00:00', 'Future')],
			now,
		);
		expect(groups.flatMap((g) => g.items.map((e) => e.title))).toEqual(['Future']);
	});
});

describe('formatEventTime', () => {
	it('formats a start time and tolerates bad input', () => {
		expect(formatEventTime('2026-07-06T12:00:00')).toMatch(/12:00/);
		expect(formatEventTime('nope')).toBe('');
	});
});
