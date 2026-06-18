/**
 * useCopyOperations
 *
 * Copy a meeting's full transcript or summary to the clipboard as markdown.
 *
 * The BlockNote ref from the React version becomes an optional
 * `getSummaryMarkdown` callback supplied by the editor component (Phase 6).
 */

import { invoke } from '@tauri-apps/api/core';

import type { Summary, Transcript } from '$lib/types';
import { Analytics } from '$lib/analytics';
import { toast } from '$lib/toast';

interface MeetingShape {
	id: string;
	title?: string;
	created_at: string;
}

interface PaginatedTranscripts {
	transcripts: Transcript[];
	total_count: number;
	has_more: boolean;
}

export interface UseCopyOperationsOptions {
	meeting: MeetingShape;
	getMeetingTitle: () => string;
	getAiSummary: () => Summary | null;
	/** Optional: editor-provided markdown getter (set when the editor is mounted). */
	getSummaryMarkdown?: () => Promise<string>;
}

export interface UseCopyOperations {
	handleCopyTranscript: () => Promise<void>;
	handleCopySummary: () => Promise<void>;
}

function formatTime(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined) return fallback;
	const total = Math.floor(seconds);
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

export function useCopyOperations(options: UseCopyOperationsOptions): UseCopyOperations {
	const { meeting, getMeetingTitle, getAiSummary, getSummaryMarkdown } = options;

	const fetchAllTranscripts = async (meetingId: string): Promise<Transcript[]> => {
		try {
			const firstPage = (await invoke('api_get_meeting_transcripts', {
				meetingId,
				limit: 1,
				offset: 0
			})) as PaginatedTranscripts;

			if (firstPage.total_count === 0) return [];

			const all = (await invoke('api_get_meeting_transcripts', {
				meetingId,
				limit: firstPage.total_count,
				offset: 0
			})) as PaginatedTranscripts;
			return all.transcripts;
		} catch (error) {
			console.error('Error fetching all transcripts:', error);
			toast.error('Failed to fetch transcripts for copying');
			return [];
		}
	};

	const handleCopyTranscript = async (): Promise<void> => {
		const all = await fetchAllTranscripts(meeting.id);
		if (all.length === 0) {
			toast.error('No transcripts available to copy');
			return;
		}

		const title = getMeetingTitle() ?? meeting.title;
		const header = `# Transcript of the Meeting: ${meeting.id} - ${title}\n\n`;
		const date = `## Date: ${new Date(meeting.created_at).toLocaleDateString()}\n\n`;
		const body = all
			.map((t) => `${formatTime(t.audio_start_time, t.timestamp)} ${t.text}  `)
			.join('\n');

		await navigator.clipboard.writeText(header + date + body);
		toast.success('Transcript copied to clipboard');

		const wordCount = all.map((t) => t.text.split(/\s+/).length).reduce((a, b) => a + b, 0);
		await Analytics.track('copy', {
			type: 'transcript',
			meeting_id: meeting.id,
			transcript_length: all.length.toString(),
			word_count: wordCount.toString()
		});
	};

	const handleCopySummary = async (): Promise<void> => {
		try {
			let summaryMarkdown = '';
			const aiSummary = getAiSummary();

			if (getSummaryMarkdown) {
				summaryMarkdown = await getSummaryMarkdown();
			}

			if (!summaryMarkdown && aiSummary && 'markdown' in aiSummary) {
				summaryMarkdown = (aiSummary as { markdown?: string }).markdown ?? '';
			}

			if (!summaryMarkdown && aiSummary) {
				summaryMarkdown = Object.entries(aiSummary)
					.filter(
						([key]) =>
							key !== 'markdown' &&
							key !== 'summary_json' &&
							key !== '_section_order' &&
							key !== 'MeetingName'
					)
					.map(([, section]) => {
						if (
							section &&
							typeof section === 'object' &&
							'title' in section &&
							'blocks' in section
						) {
							const heading = `## ${section.title}\n\n`;
							const content = section.blocks
								.map((block: { content: string }) => `- ${block.content}`)
								.join('\n');
							return heading + content;
						}
						return '';
					})
					.filter((s) => s.trim())
					.join('\n\n');
			}

			if (!summaryMarkdown.trim()) {
				toast.error('No summary content available to copy');
				return;
			}

			const title = getMeetingTitle();
			const dateFmt: Intl.DateTimeFormatOptions = {
				year: 'numeric',
				month: 'long',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			};
			const header = `# Meeting Summary: ${title}\n\n`;
			const metadata =
				`**Meeting ID:** ${meeting.id}\n` +
				`**Date:** ${new Date(meeting.created_at).toLocaleDateString('en-US', dateFmt)}\n` +
				`**Copied on:** ${new Date().toLocaleDateString('en-US', dateFmt)}\n\n---\n\n`;

			await navigator.clipboard.writeText(header + metadata + summaryMarkdown);
			toast.success('Summary copied to clipboard');

			await Analytics.track('copy', {
				type: 'summary',
				meeting_id: meeting.id,
				has_markdown: (!!aiSummary && 'markdown' in aiSummary).toString()
			});
		} catch (error) {
			console.error('Failed to copy summary:', error);
			toast.error('Failed to copy summary');
		}
	};

	return { handleCopyTranscript, handleCopySummary };
}
