import {
	Calendar,
	FileText,
	GitBranch,
	HelpCircle,
	ListChecks,
	Mail,
	Radar,
	ScrollText,
	Search,
	Smile,
	Sparkles,
	Users,
} from '@lucide/svelte';
import type { Component } from 'svelte';

import MueslyBar from '$lib/components/icons/MueslyBar.svelte';

/**
 * When a bar is useful, in Granola's terms: before / during / after a single
 * meeting, or across meetings. A bar can span several. Drives grouping and
 * filtering on the Bars page and which chat surface offers it.
 */
export type BarScenario = 'before' | 'during' | 'after' | 'across';

/** Scenario display metadata, in natural (meeting-lifecycle) order. */
export const BAR_SCENARIOS: { value: BarScenario; label: string }[] = [
	{ value: 'before', label: 'Before a meeting' },
	{ value: 'during', label: 'During a meeting' },
	{ value: 'after', label: 'After a meeting' },
	{ value: 'across', label: 'Across meetings' },
];

/** The two chat surfaces that run bars, and which scenarios each offers. */
export type ChatSurface = 'meeting' | 'global';
export const SCENARIOS_BY_SURFACE: Record<ChatSurface, BarScenario[]> = {
	meeting: ['during', 'after'],
	global: ['before', 'across'],
};

/** Plain data shape (also what the gitignored imported file provides). */
export interface ImportedBar {
	id: string;
	title: string;
	description: string;
	prompt: string;
	scenarios: BarScenario[];
	icon: string;
}

export type BarSource = 'builtin' | 'imported' | 'user';

export interface Bar extends ImportedBar {
	source: BarSource;
}

/** Icon key -> component. Bars reference an icon by name (string) so the
 *  generated/persisted data stays serialisable; the UI resolves it here. */
const BAR_ICONS: Record<string, Component> = {
	'muesly-bar': MueslyBar,
	'scroll-text': ScrollText,
	'list-checks': ListChecks,
	sparkles: Sparkles,
	mail: Mail,
	'help-circle': HelpCircle,
	calendar: Calendar,
	users: Users,
	search: Search,
	radar: Radar,
	'git-branch': GitBranch,
	'file-text': FileText,
	smile: Smile,
};

export function barIcon(name: string): Component {
	return BAR_ICONS[name] ?? Sparkles;
}

/** Selectable icon names for the bar editor. */
export const BAR_ICON_NAMES: string[] = Object.keys(BAR_ICONS);

/** muesly's own, ship-safe bar set. The catalog works with just these even
 *  when no imported file is present. */
const BUILTIN_BARS: Bar[] = [
	{
		id: 'builtin:summary',
		title: 'Summarize',
		description: 'A concise summary of the meeting.',
		prompt: 'Give me a concise summary of this meeting.',
		scenarios: ['after'],
		icon: 'scroll-text',
		source: 'builtin',
	},
	{
		id: 'builtin:actions',
		title: 'Action items',
		description: 'To-dos with owners and due dates where mentioned.',
		prompt:
			'List the action items from this meeting, with owners and due dates where mentioned. Keep each item concrete and actionable.',
		scenarios: ['after'],
		icon: 'list-checks',
		source: 'builtin',
	},
	{
		id: 'builtin:decisions',
		title: 'Key decisions',
		description: 'The decisions made, and what is still open.',
		prompt: 'What key decisions were made in this meeting, and what is still unresolved?',
		scenarios: ['after'],
		icon: 'git-branch',
		source: 'builtin',
	},
	{
		id: 'builtin:email',
		title: 'Follow-up email',
		description: 'A short recap email with next steps.',
		prompt:
			'Draft a short, friendly follow-up email summarizing this meeting and the agreed next steps. Use placeholders like [name] where you are missing details.',
		scenarios: ['after'],
		icon: 'mail',
		source: 'builtin',
	},
	{
		id: 'builtin:missed',
		title: 'What did I miss?',
		description: 'Catch up on the last few minutes.',
		prompt:
			'I stepped away for a bit. In 1-3 bullets, what did I miss and what are the key takeaways so far?',
		scenarios: ['during'],
		icon: 'help-circle',
		source: 'builtin',
	},
	{
		id: 'builtin:recent-todos',
		title: 'Recent to-dos',
		description: 'Outstanding to-dos across recent meetings.',
		prompt:
			'List my outstanding to-dos across recent meetings, grouped by urgency. For each, note the meeting it came from.',
		scenarios: ['across'],
		icon: 'list-checks',
		source: 'builtin',
	},
	{
		id: 'builtin:weekly-recap',
		title: 'Weekly recap',
		description: 'What happened across meetings this week.',
		prompt:
			'Summarize what happened across my meetings in the last 7 days: what shipped, what got decided, and what is still open. Keep it tight.',
		scenarios: ['across'],
		icon: 'scroll-text',
		source: 'builtin',
	},
	{
		id: 'builtin:open-decisions',
		title: 'Open decisions',
		description: 'Decisions still awaiting a call.',
		prompt:
			'Across my recent meetings, what important decisions are still unresolved or waiting on someone? Note who owns each.',
		scenarios: ['across'],
		icon: 'git-branch',
		source: 'builtin',
	},
];

// Bars imported from Granola's recipe set (title, prompt, scenarios, icon).
const IMPORTED_BARS: Bar[] = [
	{
		id: 'imported:suggest-questions',
		title: 'Suggest Questions',
		description:
			'Generates three thoughtful follow-up questions based on the meeting context to encourage further discussion.',
		prompt:
			'I want to contribute meaningfully to this meeting by asking an engaged and interested question. \n\n- Consider my role in this meeting, make sure the question aligns with my interests as a participant. \n- Ask questions that respond directly to the conversation currently being had, they can be simple questions\n- The point of the question is not to demonstrate my own knowledge, but to open the conversation up helpfully. \n- Present only three thoughtful follow up questions based on the recent context\n- Use human language, do not overcomplicate it',
		scenarios: ['during'],
		icon: 'mail',
		source: 'imported',
	},
	{
		id: 'imported:What-did-I-miss',
		title: 'What Did I Miss',
		description: 'Summarizes the most recent conversation beats in a meeting transcript.',
		prompt:
			"I'm in a meeting and zoned out briefly. Help me catch up by reading through the most recent part of the transcript for me. \n\n- Do not introduce the answer, just answer directly\n- Summarize only the most immediate things that were said\n- Use 1-3 bullet points for easy reading\n- If a solo meeting, just summarize directly\n- If not a solo meeting, summarize only what they said\n- Do not use quotes or quotation marks\n\nI am still in the meeting and trying to pay attention, so make sure the last few beats of the meeting are summarized neatly and succinctly.",
		scenarios: ['during'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:write-tldr',
		title: 'Write Tldr',
		description: 'Two bullet meeting summary for sharing with your team',
		prompt:
			'What\'s the tldr of this meeting? Write three short sentences that are appropriate for pasting over to share with my team immediately. The first sentence should say something like "Met with [name of person/company] to discuss [main topic]." Format it as\n\nSentence 1\n- Sentence 2\n- Sentence 3',
		scenarios: ['after'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:Look-Again',
		title: 'Look Again',
		description:
			'Identifies surprising, deeper, and more incisive questions that could have been asked during the conversation.',
		prompt:
			'What questions are you surprised were not covered in this conversation? What questions should I have been asking instead of the ones I posed? Great questions surface the crux of a matter—which questions could have cut deeper into the topic at hand? If we have 15 more minutes to discuss this further, what would have been the most incisive questions for us to tackle together?',
		scenarios: ['before', 'during', 'after'],
		icon: 'help-circle',
		source: 'imported',
	},
	{
		id: 'imported:best-practices',
		title: 'Best Practices',
		description:
			'Distills universal principles and actionable strategies from meeting transcripts related to a specific, chosen concept, to help you scale up learnings to share with others',
		prompt:
			'I want to to scale up learnings from my business to share with others (new hires, people new to the community, interns or others that are learning about the industry or the business) and also to re-examine our own beliefs/strategies/best practices. \n\nYour job is to start by asking me: "Which topic or idea would you like distilled? (Answers include "GTM strategy, marketing, recruitment" or other areas of focus for startups"  \nWait for my answer before proceeding.  \n\nOnce I provide the concept, take that concept and distill universal beliefs, insights, ideologies, policies, strategies and/or tactics as it relates to that concept across all of these meetings.  \n\n\nFocus on extracting:\n-  General principles and frameworks that apply broadly\n- Actionable strategies and tactics without example-specific context\n- Universal patterns and best practices\n- Foundational beliefs and philosophies  \n\nExclude and do not reference:\n- Specific company names, founder names, or the like\n- Details about active fundraising rounds or fundraising status\n- Company-specific financial metrics or valuation information\n- Proprietary strategies tied to individual companies\n\nPresent insights as standalone principles that any startup could apply, removing all identifying details while preserving the core strategic value.',
		scenarios: ['across'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:write-PRD',
		title: 'Write PRD',
		description:
			"Fills out Lenny Rachitsky's PRD template for a feature of your choice. Read the  original blogpost that inspired this recipe here: https://uxdesign.cc/how-to-solve-problems-6bf14222e424",
		prompt:
			'Your task is to write a PRD in the style of Lenny Rachitsky in the below format. First you will read the template structure and advice on how to fill it out using context from my meetings, then you will read the clean template itself, and finally there are style and content instructions.\n\nFirst response is something like:\n\n“I\'m going to ask you a few questions before filling out Lenny\'s PRD for you. First up: What would you like a PRD for? I can scan your recent meetings and draft a PRD, or you can name the project.”\n\nPropose up to 3 likely candidates using:\n\n**Project:** <inferred title>\n- **Why it’s a match:** <1 line>\n\nWait for user selection (or new project name).\n\nOn selection, use only the chosen meeting(s) + clearly related follow-ups (same project keywords/participants within 14 days). Do not merge unrelated threads.\n\nBefore drafting the full PRD, crystallize a 1-sentence problem hypothesis from the selected meetings. Show it for quick confirmation.\n\nIf the user confirms, proceed to full PRD; otherwise refine and align first.\n\n\nSECTION I: TEMPLATE STRUCTURE\n\nInstructions: Write a PRD using the format below. Sections 4a, 4b, 4c, and 5 are the longest and require extensive thought. The rest can be a few bullet points maximum. Leave a line break after each major section.\n\n**1. Description: What is it?**  \nDescribe what you\'re thinking so that folks reading this doc can quickly understand what this project is all about. Keep it concise and digestible.\n\n[Detailed guidance: The problem statement is foundational - spend extra time here. Think of it like a hypothesis.  \nKey attributes of strong problem statements:\n\n- Short: Aim for a single sentence. The more explanation needed, the less clear it becomes\n    \n- Focused: Single clear problem owned by one team, solvable in reasonable time\n    \n- References a "need": Focus on user need (or business need). Use Jobs-To-Be-Done framework\n    \n- Includes what and why: What\'s going wrong, and why is it a problem?\n    \n- Solution-agnostic: Resist jumping to solutions early  \n    Examples of GOOD problem statements:\n    \n- "Lyft drivers are canceling rides too often because the passengers are too far away."\n    \n- "Airbnb hosts are feeling frustrated because they want to improve but are finding it difficult to figure out how."\n    \n- "Users are dropping off at too high a rate at the final step of the signup flow."  \n    Examples of BAD problem statements:\n    \n- "User growth is slowing." (Too broad, not user-centered)\n    \n- "Build a loyalty program." (Assumes a solution)\n    \n- "Users are bouncing from the signup flow." (Not focused enough, missing hypothesis)]\n   \n\n---\n\n**2. Problem: What problem is this solving**\n\n**2a. What is the problem this project addresses? (Ideally in 1 sentence)**\n- (response)\n\n[See guidance above under Section 1: PROJECT DESCRIPTION.]\n\n\n**2b. What is your hypothesis for why this problem is happening?**\n- (response)\n\n\n**2c. What problems are you NOT solving?**\n- (response)\n\n---\n\n**3. Why: How do we know this is a real problem and worth solving?**\n\nImpact of the Problem:\n\nBusiness Impact:\n- [2-3 strong data points]\n    \n\nCustomer Impact:\n- [2-3 bullet points]\n    \n\n[This is where you collect evidence backing up your problem statement. What initially convinced you this was a problem? What makes it clear this needs to be tackled?  \n\nTips for this section:\n\n- Look at both quantitative and qualitative evidence: Collect all data points pointing to this being real and important\n    \n- Quality over quantity: 3-5 strong data points better than dozens of weak ones. Your case gets weaker with too many minor/unrelated points\n    \n- Play devil\'s advocate: Try to convince yourself this isn\'t actually real or big enough. What gaps exist in your evidence?\n    \n- It\'s a judgment call: Make the best case with available data. Continue refining as you learn more]\n    \n---\n\n**4. Success: How do we know if we\'ve solved this problem?**  \nDefine specific, measurable goals that connect to team KPIs.\n\n[This criteria becomes critical throughout the project for decision-making and prioritization. Does feature X increase chances of achieving your goal? If not, cut it.  \nIdeally your metrics are:\n\n- Specific with defined goals that are easily measurable\n    \n- Directly connected to team KPIs\n    \n- Based on hard data about opportunity size, investment size, and past experiment heuristics  \n    Guidelines:\n    \n- Make it concrete: Try for specific numbers (e.g., 10% increase in X, 50% decrease in Y, 20% adoption of feature Z within 3 months)\n    \n- Believable but ambitious: What goal would excite your team and leaders?\n    \n- If metrics don\'t make sense: Concretely describe what success looks like in the world]\n    \n\n---\n\n**5. Audience: Who are we building for?**  \n Be concise and specific.\n\n---\n\n**6. What: Roughyl, what does this look like in the product?**  \nLink to designs if available.\n\n[This is where you describe the solution to the problem. Detail level depends on team operations and current knowledge.  \nKey tip: Align with designers on how much detail they want and what would be most helpful in their process.]\n\n---\n\n**7. How: What is the experiment plan?**  \n\n\n---\n\n**8. When: When does it ship and what are the milestones?**  \n\n\nStructure as: Milestone, Date, Risks, Mitigations\n\n[Detailed guidance: Structure each milestone with these four elements:\n\nMilestone: [Description]  \n- Date: [Timeline]\n- Risks: [Potential blockers]\n- Mitigations: [How to address risks]  \n    For unconfirmed timelines, be clear they\'re tentative and specify who can confirm.]\n    \n\n---\n\nTemplate Output Structure:\n\n# 1. Description: What is it?\n\nDescribe what you\'re thinking so that folks reading this doc can quickly understand what this project is all about. Keep it concise and digestible.\n\n---\n\n# 2. Problem: What problem is this solving?\n\n **2a. What is the problem this project addresses? (Ideally in 1 sentence)** \n - [response]\n **2b. What is your hypothesis for why this problem is happening?** \n - [response]\n **2c. What problems are you NOT solving?**\n - [response]\n\n---\n\n# 3. Why: How do we know this is a real problem and worth solving? \n\nImpact of the Problem: \n\n**Business Impact:**  \n- [2-3 strong data points]\n\n**Customer Impact:**  \n- [2-3 bullet points]\n\n---\n\n# 4. Success: How do we know if we’ve solved this problem?\nDefine specific, measurable goals that connect to team KPIs. \n\n---\n\n# 5. Audience: Who are we building for? \nBe concise and specific. \n\n---\n\n# 6. What: Roughly, what does this look like in the product?\n Link to designs only if available. \n\n---\n\n# 7. How: What is the experiment plan?\n\n---\n\n# 8. When: When does it ship and what are the milestones?\nWhen does it ship and what are the milestones?\n\nStructure as: Milestone, Date, Risks, Mitigations\n\nFORMATTING RULES\n- Use bold for all section headings\n- Write in full sentences where needed\n- Use bullets for bullet points\n- Leave a line break between sections\n- Keep everything scannable and professional\n\nCONTENT RULES\n- Do not invent answers where you can\'t find them, or infer what you think reasonable answers might be\n- It is ok to leave a section blank, or indicate that the answer wasn\'t found in the source material. \n\nYou are now ready to fill out Lenny\'s PRD template and create an essential and helpful bit of documentation for my team.',
		scenarios: ['across'],
		icon: 'file-text',
		source: 'imported',
	},
	{
		id: 'imported:Streamline-my-calendar',
		title: 'Streamline My Calendar',
		description: 'Suggests three things to improve your week',
		prompt:
			"Look at the next seven days and tell me 2-3 things that would actually make my upcoming week better. Be conversational about it. \n\nA couple of rules:\n- Recurring meetings like standups are hard to move and are rarely worth remarking on\n- External meetings are harder to move than internal ones\n- Large group meetings are harder to reschedule than 1:1s\n- Meeting series are stickier than one-offs\n- Consider the wider context of what I'm working on this week\n- Flag meetings with senior leadership that need prep time blocked beforehand\n- Don't suggest moving meetings if I'd lose momentum on related work\n- Consider logistics for meetings that are held outside the office\n- Understand the distinction between meetings I've organized and meetings I'm attending\n- Recognize that some events may be placeholders, scheduled telephone calls, or reminders to self (no attendees) and treat them as such depending on context implied by their name. \n- Back to back meetings are when I have a number of meetings without a break in between them, for example 12:30-1pm, 1pm-2pm, 3-3:30pm, 3:30-5pm. It's ok to have two meetings one after the other.\n\n\nUse bold and bullets to make it easy to scan. Open with a brief and friendly assessment of the state of my week right now.\n\nFormat your response like this:\nStart with a brief, friendly assessment of my week in 1-2 sentences\nFor each suggestion, use **bold for the main recommendation**\nUse bullet points under each suggestion for supporting details or reasoning\nKeep it scannable - no long paragraphs\n\n<example>\n**Move your 1:1 with Jake from Tuesday 2pm to Wednesday 3pm**\n* You've got four meetings back-to-back on Tuesday with no breathing room\n* Wednesday afternoon is completely free and perfect for a deeper conversation\n\n**Skip the \"Q1 Planning Brainstorm\" on Thursday**\n* You're already in the Monday strategy session which covers the same ground\n* Large group meeting where you won't be missed\n* Gives you time to actually prep for your Friday board presentation\n\n**Block 30 minutes Wednesday morning for board deck prep**\n* That Friday presentation looks high-stakes and you haven't scheduled prep time\n* Wednesday morning gives you enough time to get feedback before the meeting\n* You'll feel way more confident going in\n</example>\n\nIf my week doesn't seem too bad or full of meetings, you could suggest ways to block my time to focus on the work at hand, referencing upcoming meetings and deadlines that may be linked to those meetings. \n\nRemember, you don't have my full context, so just make light touch suggestions.",
		scenarios: ['across'],
		icon: 'calendar',
		source: 'imported',
	},
	{
		id: 'imported:coach-me-Matt',
		title: 'Coach Me Matt',
		description:
			'Delivers leadership coaching advice based on the Mochary Method. Read the curriculum that inspired the recipe here: mocharymethod.com/learn',
		prompt:
			'<Matt Mochary Curriculum>\n### 1. The Foundational Pillars: ACT and The Emotional Brain\n\nThe Mochary Method is a framework built on three foundational pillars: **Accountability**, **Coaching**, and **Transparency** (ACT). This methodology aims to create highly effective and efficient organizations by ensuring everyone is aligned, responsible, and continually improving.\n\n* **Accountability** involves setting a clear destination (Vision, OKRs, KPIs), defining the specific actions to get there, and then verifying whether those actions were completed.\n* **Coaching** focuses on the current state of the organization, department, or individual. It means describing what’s working, what\'s not working, and proposing solutions to problems.\n* **Transparency** is about fostering a culture where people can give and receive feedback openly and regularly. This feedback should be directed to a person\'s manager, peers, and reports.\n\nA core teaching that underpins all of these principles is the idea that **fear and anger give bad advice**. When you experience these emotions, your brain\'s pre-frontal cortex, responsible for creative thought and problem-solving, is bypassed by the amygdala, or "reptile brain," which is wired for fight or flight. This leads to knee-jerk reactions and poor decision-making. The solution is to intentionally "shift" out of these emotions before acting. For example, if you are in a state of anger and want to "crush" someone who has wronged you, the recommended action is to get curious about their motivations instead.\n\n---\n\n### 2. Meetings: A Framework for Efficiency\n\nMeetings are often seen as a drain on productivity, but the Mochary Method provides a structured approach to make them essential and efficient. The key is to shift as much work as possible to asynchronous preparation, reserving synchronous time for what is truly necessary.\n\n#### The Anatomy of an Effective Meeting\nEvery meeting must have a **Meeting Owner** who is responsible for its success. The owner is a crucial role, ensuring all necessary steps are taken, including:\n* **Desired Outcome**: A clear, written statement of the meeting\'s purpose.\n* **Asynchronous Preparation**: Most status updates, issues, and data reviews should be written and shared in advance. This allows attendees to read and comment beforehand, leading to a much shorter and higher-quality discussion.\n* **Time-boxing**: The synchronous agenda must be time-boxed, with a specific duration for each item. This prevents discussions from running long and ensures all topics are covered.\n* **Actions**: Every decision or issue resolution must result in a clear action item, assigned to a **Directly Responsible Individual (DRI)** with a due date. These actions should be tracked in a central system, like Asana or Notion, to ensure accountability.\n* **Feedback**: The meeting should conclude with a request for written feedback on the meeting itself. This builds trust and provides valuable insights for improvement.\n\n#### Rethinking the 1-on-1 and Group Meetings\nOne of the most significant shifts in the Mochary Method is the elimination of traditional 1-on-1 meetings in favor of **Group 1-1s**. This approach brings all direct reports into a single meeting, which has several benefits:\n* **Time Savings**: It consolidates discussions, saving hours per week for the CEO.\n* **Increased Transparency**: Information is no longer siloed, and everyone benefits from shared insights and feedback.\n* **Faster Decision-Making**: Key stakeholders are present, allowing for real-time decisions.\n\nThe curriculum also details a specific **1-on-1 template** that can be used for individual or group meetings. This template guides a conversation through accountability, coaching, and transparency, ensuring all critical topics are addressed.\n\n---\n\n### 3. Fostering a Culture of Feedback and Trust\n\nA strong company culture is built on trust, and trust is built through transparent and frequent feedback. The Mochary Method provides detailed guidelines for both giving and receiving feedback, transforming a potentially uncomfortable process into a valuable gift.\n\n#### The 5 A\'s of Receiving Feedback\nWhen you, as a leader, receive feedback, you must handle it with care to encourage more of it. The five A\'s provide a clear process:\n1.  **Ask for it**: Actively solicit negative feedback. The curriculum suggests a technique: "Don\'t tell me. Please just think it. Do you have it in your brain chamber? Yes? Now please tell me". This acknowledges the risk for the employee and creates a safe space.\n2.  **Acknowledge it**: Repeat back what you heard in your own words until the person confirms, "That\'s right". You can even go to an "advanced level" by exaggerating what you think they\'re truly feeling, which often makes them feel more heard.\n3.  **Appreciate it**: Simply say "Thank you" for the gift of feedback, without making excuses or arguing.\n4.  **Accept it (or not)**: You don\'t have to agree with or accept all feedback, but you must be transparent about your decision. If you don\'t accept it, explain your reasoning clearly.\n5.  **Act on it**: If you accept the feedback, co-create a specific action item with a due date and complete it, closing the feedback loop.\n\n#### Building and Strengthening Relationships\nThe ability to build meaningful relationships is critical for leaders. The **Relationship Method** is a counterintuitive approach to building trust, especially with investors, customers, or recruits. Instead of immediately pitching your company, you spend time getting to know them as a human being.\n\nThe four keys to this method are:\n1.  **Ask** them about their lives.\n2.  **Prove you heard them** by repeating back what they said.\n3.  **Prove you remember** by referencing those details in future conversations.\n4.  **Let them know what you appreciate** about them.\n\nFor example, a quick text message like, "I saw this article on tennis and thought of you," shows you are thinking of them and remember what\'s important to them. This builds a bond that is more powerful than a formal pitch.\n\n---\n\n### 4. Hiring and Onboarding: The A-Player Machine\n\nThe goal of recruiting is to build a team of only **A-players**—talented, collaborative individuals who fit your culture. The process must be highly efficient, minimizing time spent on candidates who won\'t be hired.\n\n#### The Recruiting Process\n* **The Anti-Sell**: In the very first interview, describe the most challenging aspects of the job and company culture. This filters out candidates who aren\'t a genuine fit, saving time for both parties.\n* **Speed**: The hiring process should be as fast as possible to signal your conviction and love for the candidate. A slow process can cause you to lose top talent to other companies.\n* **Top-Grading Reference Checks**: Don\'t rely on the candidate\'s provided references. Instead, ask for the names of their direct managers and peers from past jobs during the interview. A verbal offer is then made contingent on successful reference interviews with these unvetted contacts.\n* **Spouse Engagement**: A candidate\'s spouse\'s fears about the career move can be the biggest blocker. The curriculum recommends offering to speak directly with the spouse to address their concerns, which can significantly increase the close rate.\n\n#### Onboarding and Training\nHiring external executives is often a "failure of training". The ideal approach is to build a robust internal manager training program that allows existing team members to grow into leadership roles, ensuring a consistent management system across the company.\n\nFor new hires, especially executives, the curriculum suggests a **shadowing** process. For the first 30-60 days, the new hire should simply observe the person currently in the role, attending all meetings and gaining full context. This dramatically increases their chance of success. After they take over, a period of **reverse-shadowing** is recommended, where you observe their performance and provide feedback.\n\n---\n\n### 5. Managing Your Time and Energy\n\nA CEO\'s most valuable assets are their time and energy. Managing them effectively is crucial for both personal well-being and company success.\n\n#### The Energy Audit\nThe **Energy Audit** is a monthly exercise designed to help you identify which activities give you energy and which drain it. The goal is to spend at least 75-80% of your time on things that energize you, or your **Zone of Genius**.\n\n* **Zone of Incompetence**: Activities others do better than you (e.g., fixing your car).\n* **Zone of Competence**: Activities you do fine, but others are just as good at (e.g., cleaning your bathroom).\n* **Zone of Excellence**: Activities you are excellent at but don\'t love doing. This is the "danger zone" because people will want you to keep doing them, but they can burn you out.\n* **Zone of Genius**: Activities you are uniquely good at and love to do so much that time and space disappear when you\'re doing them.\n\nFor activities in the first three zones, the goal is to outsource, eliminate, or make them "exquisite".\n\n#### The "Fireman" CEO and Calendar Cadence\nA great CEO operates like a fireman. They don\'t do the work of any single department but manage the executive team, keeping large blocks of time open to put out fires when they arise. When there are no fires, this time is used for high-leverage activities that only the CEO can do, such as long-term visioning and building stakeholder relationships.\n\nTo support this, the curriculum suggests a **Calendar Cadence** that protects uninterrupted "maker" time for engineers and designers. The ideal schedule is one day for internal meetings, one for external meetings, and three days with no meetings at all.\n\n---\n\n### 6. Tools for Organizational Excellence\n\nTo scale successfully, you need a robust management system. The Mochary Method offers several tools to create a streamlined and transparent organization.\n\n#### Getting Things Done (GTD) and Inbox Zero\n**Getting Things Done** is a personal productivity system that helps you manage all your tasks and commitments. It involves processing all your inboxes daily, writing down the "next action" for any task over two minutes, and organizing these actions into clear lists.\n\nThe goal of **Inbox Zero** is to address all urgent messages immediately and maintain a clear inbox. The curriculum recommends checking your inbox only twice a day and using the GTD methodology to process messages into action items.\n\n#### Accountability and Conflict Resolution\nA central **Agreement Tracker** is essential for any company over 20 people or operating remotely. It ensures that all agreed-upon actions are tracked to completion, providing transparency and boosting morale. The key is that each person has only one location to look to see all their commitments.\n\nWhen conflict arises between departments, the curriculum offers the concept of a **Clean Escalation**. Instead of complaining to a manager in private, the two parties jointly approach their shared "Apex Manager" with written proposals. This forces them to present both sides of the issue simultaneously, leading to a more informed and efficient resolution.\n\n#### Decision-Making\nTo get team buy-in, you must involve them in the decision-making process. There are three methods depending on the significance of the decision:\n* **Method 1 (Low Impact)**: The decision-maker makes the decision and announces it.\n* **Method 2 (Medium Impact)**: The decision-maker presents a written "straw man" and invites feedback from the team.\n* **Method 3 (High Impact)**: The team brainstorms solutions from scratch, the decision-maker listens to all ideas, then creates a straw man for further feedback before making the final decision.\n\nThe **RAPID** framework is a tool for making complex, cross-functional decisions. It defines clear roles: **R**ecommend, **A**gree, **P**erform, **I**nput, and **D**ecide, ensuring everyone knows their part in the process. A great example of this is when Coinbase used RAPIDs to scale its business operations.\n\n---\n\n### 7. Personal Development for the CEO\n\nBeing a great leader is an ongoing process of self-improvement. The Mochary Method provides tools to help a CEO continually grow.\n\n#### Mental Health and Rest\nThe intense demands of a CEO role can lead to burnout. The curriculum normalizes this struggle and provides tools for recovery. The **Energy Audit** helps you consciously design your work life to be energizing. This includes finding ways to "get bored" and disconnect from distractions to allow for mental rest and creativity.\n\n#### Conscious Leadership\n**Conscious Leadership** is about being more interested in learning than in being right. It requires recognizing when you\'re driven by emotions like fear or anger and then shifting to a state of curiosity. A key practice is taking **100% responsibility** for the situations you find yourself in, which gives you the power to change them.\n\nThe curriculum also provides a set of **Magic Questions** to be asked in monthly 1-on-1s to gauge a team member\'s satisfaction in both their work and personal life. This shows you care about them as a human being, which is a powerful motivator.\n\n#### The Importance of Praise\nMotivation is best maintained by joy, not fear. As a manager, your primary job is to help your team maintain their motivation by giving frequent praise. The praise should be specific, pointing to a particular action rather than a general personality trait. For example, instead of "You are so helpful," say "Thank you for doing the dishes last night". This builds trust and encourages more positive behavior.\n</Matt Mochary Curriculum>\n\nBefore generating your output, first read all provided context, carefully consider my specific role and responsibilities, and adapt your coaching advice so it’s directly relevant to my situation and role.\n\nYou are Matt Mochary. Focusing on the past week give me brief and insightful advice from a coaching session telling me how I can improve professionally. I\'ve included notes on your curriculum above for easy reference. Be very specific and concrete with your suggestions and examples. \n\nOpen with a sharp and short analytical introduction about how I\'m doing right now, applying Matt Mochary\'s wisdom and coaching style. \n\nYou should output no more than 5 points, combining insights and recommendations. Use markdown; ## for headings and write in prose beneath it.',
		scenarios: ['across'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:Make-notes-longer',
		title: 'Make Notes Longer',
		description: 'Rewrites meeting notes so they are longer and more detailed',
		prompt:
			'Either rewrite these meeting notes so they are longer and more detailed, or if a section of text is highlighted and has been shared, make just that section longer and more detailed.',
		scenarios: ['after'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:suggest-topics',
		title: 'Suggest Topics',
		description:
			'Potential topics to cover in this meeting based on context from your previous meetings',
		prompt:
			"I'm about to have a meeting and I haven't had much time to prepare for it. Can you analyze my upcoming meeting context, review my recent meeting history, and generate useful call prep notes. \n\n**Steps (internal only, do not output):**  \n1. Confirm meeting title, time, attendees.  \n2. Classify meeting type from title/attendees (1:1, project sync, interview, external call, board, networking, or unknown).  \n3. Review recent meeting history:  \n   - Prioritize the last 1–2 meetings with that attendee for context.  \n   - Add older notes only if still active/relevant, and especially for recurring meetings with similar or the same titles.  \n   - Include related meetings with these attendees.  \n   - If there is not related or recent meeting history that appears relevant to this conversation, then first identify it as a meeting with [person] from [company name, only implied by their domain (ie, not gmail)] either ask clarifying questions, or make general recommendations based on the type of meeting and my company context]\n4. For 1:1s, add role and responsibility-aware reflections or questions, not just updates.  \n\nAlways respond in human sounding language, avoid jargon. \n\n<output_template>\n[One-sentence introduction confirming the upcoming meeting name and time organically, e.g. _“1:1 with Sam at 11am”_ or _“Platform project catch-up meeting”_]\n\n**Who**  \n- [Skip if no external attendees. ] \n\n**Where we left off**  \n- One sentence recap of the last relevant interaction.  \n\n**Suggested topics**  \n- [2–3 scannable bullets, shaped by meeting type. ]\n- [Phrase as possibilities, not directives. ]\n\n[A single sentence confirming the context that informed this response, and asks me if there's anything else that should be considered or if I want to add details about my goals for this meeting.]\n</output_template>",
		scenarios: ['before', 'after'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:list-recent-todos',
		title: 'List Recent Todos',
		description: 'Extracts and displays your outstanding to-dos from recent meeting notes.',
		prompt:
			'Your task: Present a short list of action items, then extract and display my outstanding to-dos from recent meeting notes.\n  \n- Example format:\n* Fix broken "prep me for this meeting" feature — This is blocking the launch assessment and needs resolution first.  \n* Finalize PRD prompt and launch strategy for recipes — Launch requires a crisp strategy document ready to go.  \n* Test and improve default recipe quality — Early user feedback will shape first impressions of the release.\n\n- Add a short line before the main list: *“Here are your recent action items, organized by meeting:”*  \n\n<date_rules>\n“Ignore your internal date/time. Always assume ‘Today’ is the date I provide, or if none is provided, the date of my query. “Today” always means the calendar date on which the user is asking the question.  \nUse that as the anchor point. Meetings are then labeled relative to this anchor: “Today,” “Yesterday,” or weekday + date.  \n</date_rules>\n\n<workflow>\n1. Analyze my meeting notes in reverse chronological order.\n\n2. Apply a strict transcript filter:\n   - Only process meetings where the notes exist.\n   - If the notes do not exist, write "No notes generated".\n\n3. Extract all clear action items that you have a reasonable degree of confidence in belonging to me:\n- Err on the side of inclusion if it is likely my responsibility based on context you have about me, my role, my responsibilities. \n\n4.  Output format:\n   - Group items by day, starting with most recent (Today, Yesterday, then weekday + date).\n   - For each meeting:\n     - Bold the meeting name (if none, write **Unnamed Meeting**).\n     - If there are action items:\n       * Use `*` bullets, one per item.\n       * If an item was implied but not explicit, include it.\n     - If there are no action items: output "No action items found" or similar.\n\n5. Always show the most recent calendar day of meetings. If that’s fewer than 5 meetings, include earlier days until at least 5 meetings are shown\n   - Never split a day across outputs. If showing any meeting from a day, include all meetings from that day.  \n   - After finishing a day (and/or reaching 5+ meetings), stop and ask: “Do you want me to keep going with previous days?”  \n   - When continuing, deliver meetings in complete day chunks. Do not break a single day across messages.\n</workflow>\n\n<action_item_definition>\nAn action item is a **future commitment** I agreed to in the meeting — a task I will do after the meeting. It is not the same as a status update.  \n- “I am doing X” (current work or progress update) → NOT an action item.  \n- “I will do X” / “I’ll handle X” / “Hannah to do X” (new commitment) → Action item.\n- Be thoughtful about the distinction especially when considering stand-ups or project updates where people speak about work they\'ve been doing and will continue to do. \n\n   - Direct action items (send, review, schedule, follow up, etc.).\n   - Indirect commitments (e.g. “I’ll look into that,” “I’ll draft something,” “Let me handle it”).\n   - - If a group suggestion (e.g. “We should update docs”) seems like something I implicitly agreed to or am responsible for, include it.\n- If it is clearly assigned to someone else, exclude it.\n</action_item_definition>\n\n<format_rules>\n- Markdown is mandatory and must be preserved.\n- Use short, recognition-friendly phrasing (e.g. “Send draft contract” not “I said I’d probably send a contract at some point”).\n- Do not summarize beyond the action items.\n- Never output `* -` or an empty bullet. For meetings with no items, bullet "No action items found" or similar`.\n</format_rules>\n\n<format_example>\n## Today\n**Marketing Sync** \n* Share updated launch timeline\n\n**Workspace Migration** \n* Review and sign off on final copy\n\n**Chris <> Alex** \n* *No action items found*\n\n**Product Review** \n* Draft slides\n\n## Yesterday\n**Michael <> Chris** \n* Follow up on hiring plan\n</format_example>\n\n<reasoning_effort>\n- Medium-high: Carefully scan each meeting for explicit and implicit commitments. \n- Err on the side of inclusion if it is likely my responsibility based on context you have about me.\n- Do not invent tasks\n</reasoning_effort>\n\n<rules>\n- If a meeting has no title or "null", refer to it as "Unnamed meeting"\n</rules>\n\n<self_check>\nBefore final output:\n- Re-read extracted items and confirm no personal to dos were skipped.\n- Confirm that no `* -` formatting errors exist.\n</self_check>\n\n<continuation_rules>\n- Keep track of which meetings you have already displayed in this session.\n- When the user says “yes,” continue with the next 5ish meetings starting immediately after the last one you showed.\n- Never repeat meetings that were already displayed.\n- Always show meetings in complete day chunks.  \n- If showing any meeting from a given day, include all meetings from that day.  \n- After finishing a day, stop and ask: “Do you want me to keep going with previous days?” \n- Never split a single day across outputs.  \n</continuation_rules>\n\n\nBegin immediately with the first meeting.',
		scenarios: ['across'],
		icon: 'list-checks',
		source: 'imported',
	},
	{
		id: 'imported:write-weekly-recap',
		title: 'Write Weekly Recap',
		description: 'Generates a weekly recap of accomplishments for your team.',
		prompt:
			"I need to write a recap of my week to share with my team. The goal is for my team to understand what I worked on / accomplished. Recaps should always focus on a full calendar week. Figure out today's date - if it's beginning of the week (Sunday-Wednesday) focus on the previous calendar week, if it's the end of the week (Thurs-Sat), focus on the current week.",
		scenarios: ['across'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:Write-follow-up-email',
		title: 'Write Follow Up Email',
		description: 'Quick email to send after a meeting recapping next steps',
		prompt:
			'Write a super short and casual follow-up email that I can send based on the meeting provided. \n\nThe email should be action oriented instead of focusing on what was discussed. In general, if there\'s any information you want to include in the email but you don\'t have it, put a placeholder in (e.g. "[Insert current ARR]" or "[Insert LINK to DPA]" or "[Insert slide-deck-link]" or "[Attach DPA]").\n\nWhen I promised to do something in the meeting: \n- If it\'s something that can be done in under 5 minutes (e.g. find a document, look up some information) assume that I\'ve done it already and put in placeholders as needed. For example, let\'s say I promised to reschedule our next meeting to later, you could write "I rescheduled our next meeting to [Insert DATE]".\n- If it takes more than a couple minutes and is important, mention that I\'ll do it.\n\nWhen other people promised to do something: \n- If it\'s important, mention the things other people promised to do. It\'s always good to push people toward action, so instead of saying that Amanda needs to do X, perhaps say "Amanda, when do you think you\'ll be able to do X by?"\n\nDo not quote the transcript directly within the email, this messes up the formatting.',
		scenarios: ['after'],
		icon: 'mail',
		source: 'imported',
	},
	{
		id: 'imported:list-my-todos',
		title: 'List My Todos',
		description: 'Your action items from the meeting',
		prompt:
			"List my explicitly directed action items (To do), and implicit action items (Inferred) from this meeting. Format as a bullet list, include deadlines only where they were promised and as they relate to today’s date, prioritize by urgency. \n\nYour output should be: To do: (short bullet list of explicitly assigned action items, with deadlines if they are mentioned). Inferred (bullet list, no deadlines.) \n\nThis list needs to be actionable, so don't put anything vague or generic in there.",
		scenarios: ['after'],
		icon: 'list-checks',
		source: 'imported',
	},
	{
		id: 'imported:backstory',
		title: 'Backstory',
		description: "Catch me up on what's being discussed.",
		prompt:
			"Look at what's just been said in this meeting — the last few minutes of the transcript — and figure out what topic needs backstory. Then search my past meetings for it: when it first came up, who was involved, what we've said about it, where we left it. Keep it tight. I need to catch up without missing what's being said right now. Give me the version I can read in 20 seconds.",
		scenarios: ['during'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:trace-decision-history',
		title: 'Trace Decision History',
		description: 'Reconstructs the full decision-making history from your meetings.',
		prompt:
			"First, ask me which decision I want the history of. Once I tell you, search my meetings and reconstruct the full arc: when it first came up, who proposed it, what alternatives we considered, how the thinking shifted, and the moment it became final. I want the receipts — the provenance, not just the outcome. Sometimes I need to explain the reasoning to someone who wasn't there, and I want to be able to stand behind the story.",
		scenarios: ['across'],
		icon: 'git-branch',
		source: 'imported',
	},
	{
		id: 'imported:what-leadership-asks-about',
		title: 'What Leadership Asks About',
		description: 'What leaders keep circling back to.',
		prompt:
			"Search my meetings with senior leaders and tell me what they keep coming back to. The questions they ask repeatedly. The topics they circle even when they're not on the agenda. The things that seem to genuinely live in their head, regardless of whether they've ever made them a formal priority. I want to know what actually matters to them — so I can stop guessing and start showing up for it.",
		scenarios: ['across'],
		icon: 'help-circle',
		source: 'imported',
	},
	{
		id: 'imported:smart-1-1-agenda',
		title: 'Smart 1 1 Agenda',
		description: 'Smart 1:1 agenda from cross-meeting context.',
		prompt:
			"Look at my calendar and find my next 1:1 — if there are several coming up, ask me which one. Then build me the agenda: look at where we left off last time and what's happened in their work since, including the meetings I've sat through where their projects came up that they probably don't know I've heard. Cover the thing on their mind, the thing on my mind, and the context from elsewhere that would actually be useful for them to have. Make it the agenda a thoughtful manager would bring, not a status update.",
		scenarios: ['across'],
		icon: 'calendar',
		source: 'imported',
	},
	{
		id: 'imported:research-someone-new',
		title: 'Research Someone New',
		description: 'First-meeting research brief.',
		prompt:
			"First, ask me who I'm meeting. Once I tell you, do two things in parallel: pull up their background from the web — LinkedIn, recent writing, what their company is up to — and check my meetings for anyone who has worked with them, mentioned them, or talked about their company. Combine both into one brief: who they are, why we might be meeting, what gives me a warm way in. I want to show up knowing more than I should.",
		scenarios: ['across'],
		icon: 'users',
		source: 'imported',
	},
	{
		id: 'imported:prep-my-day',
		title: 'Prep My Day',
		description: 'My calendar today, briefed.',
		prompt:
			'Walk me through my day. Go through everything on my calendar from this morning to this evening — for each meeting, pull up the last time I spoke to those people, what got said, and what we agreed on. Order it by when the meetings are happening so I can read it with my coffee. I want to walk into every conversation today already knowing where we left off.',
		scenarios: ['across'],
		icon: 'calendar',
		source: 'imported',
	},
	{
		id: 'imported:find-the-signal',
		title: 'Find The Signal',
		description: "Pattern I'm too close to see.",
		prompt:
			"Find the signal I'm missing because it's buried across separate meetings. Look across my recent conversations for a pattern that no single meeting would reveal — a concern that's coming from different people in different rooms, a topic that keeps adjacent-ly coming up, a slow shift in how something is being talked about. The thing I can't see from inside any one conversation. Tell me what's there, where it's showing up, and what you think it might mean.",
		scenarios: ['across'],
		icon: 'radar',
		source: 'imported',
	},
	{
		id: 'imported:surprise-me',
		title: 'Surprise Me',
		description: "Something I haven't thought to ask about.",
		prompt:
			"Surprise me. You have my meetings, my calendar, and the web. Find something I haven't thought to ask about — a connection I've missed, a pattern I can't see from the inside, an opportunity I've overlooked, a risk I've been walking past. Don't tell me what you searched or how you got there. Just tell me what you found. Make it good enough that I'll want to tell someone about it.",
		scenarios: ['across'],
		icon: 'help-circle',
		source: 'imported',
	},
	{
		id: 'imported:how-I-like-to-work',
		title: 'How I Like To Work',
		description: 'Operating manual to share with my team.',
		prompt:
			"Help me write a \"how I like to work\" guide I can share with my team. Read across my meetings — including 1:1s, retros, and the conversations where I've talked about how I work best — and figure out: the kind of work I do well, the conditions I need to do it, how I prefer to communicate, what I genuinely care about, what doesn't work for me. Then write the guide in my voice, with sections a new colleague could read before our first meeting. Use specific evidence from my meetings: the patterns of what I push for, what I avoid, what I've explicitly said about how I work. Make it honest, practical, and warm. The kind of doc I'd be happy to send to someone joining my team tomorrow.",
		scenarios: ['across'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:how-I-have-changed',
		title: 'How I Have Changed',
		description: 'My arc since I started using muesly.',
		prompt:
			'How have I changed since I started using Granola? Go all the way back to my earliest meetings and compare them to the last few weeks. What was I working on then vs. now? Who was in the room? How has the way I show up shifted — what I talk about, how confidently I talk about it, what I push for, what I let go of? Tell me the story of who I was when I started, who I am now, and the turning points in between.',
		scenarios: ['across'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:Make-me-sound-smart',
		title: 'Make Me Sound Smart',
		description:
			'Generates two thoughtful statements or questions to meaningfully contribute to a meeting conversation.',
		prompt:
			'I want to contribute to this conversation and demonstrate that I\'m interested in and knowledgable about this topic. \n\n-Return exactly 2 thoughtful statements/questions that help me contribute meaningfully to the meeting\n- Use human language, favor short words and do not overcomplicate it (for example, do not say "envision" say "see", do not say "utilize" say "use")\n- Stay on topic\n- First person perspective\n- No quotation marks\n- Don\'t sound or appear pretentious\n- Can include external knowledge\n- Among other things, you can \n* Offer a countervailing perspective to consider\n* Invite people to reframe the subject\n* Question the assumptions that might be underlying the conversation\n* Ask someone to expand on an opinion they\'ve shared\n* Expand on a point of view someone else has shared\n\nThe point of these questions or statements is to open the conversation up and have a more expansive and productive conversation - and also, to make me sound smart!',
		scenarios: ['during'],
		icon: 'help-circle',
		source: 'imported',
	},
	{
		id: 'imported:Show-in-flight-projects',
		title: 'Show In Flight Projects',
		description: 'Generates a status overview of in-flight initiatives from meeting notes.',
		prompt:
			'# Job\n\nYour job is to turn the meeting notes provided into a single status overview for a manager or lead: a complete list of all in-flight initiatives from the last 2 weeks, who is on what, and the wins, blockers, and risks for each. You must list every in-flight initiative that appears in those notes—do not summarize, merge, or drop smaller threads. You are briefing someone who needs to see the whole board at a glance. Use only what\'s in the notes. Be clear, scannable, and direct.\n\n# Rules\n\n**Timebox: last 2 weeks only.** Consider only notes from the past 14 days. If notes include dates, use only those within that window. If the context you\'re given is already scoped to a time range, treat that as the window and state it in the Overview (e.g. "Based on notes from 3–17 Feb."). Do not include initiatives that only appear in older notes.\n\n**List every in-flight initiative.** Scan all notes in the timebox and enumerate every distinct project, initiative, or workstream that is actively underway or discussed as current. Do not cherry-pick "main" items or collapse several into one. If five initiatives are mentioned, output five. Missing one is a failure. When in doubt, include it as its own row.\n\n**Use only information from the notes.** Do not invent projects, owners, or status. If something isn\'t mentioned, say "Not in notes" for that slot. "In flight" means work that is actively underway or being discussed as current, not finished or cancelled.\n\n**Treat "project" loosely.** An initiative can be a named project, a theme (e.g. "Q1 launch"), or a recurring thread. If the notes don\'t use clear names, infer short labels. Each distinct piece of in-flight work gets its own entry.\n\n**One line per idea where you can.** Wins, blockers, and risks should be bullets or one line each. No long paragraphs.\n\n# Format\n\n1. **Overview** – 2–3 sentences: state that this is based on the last 2 weeks of notes (or the date range if known), the total number of in-flight initiatives you found, and overall read on health (e.g. mostly on track, a few stuck, one at risk). Include the count so the reader can confirm nothing was missed.\n\n2. **By project / initiative** – One block per in-flight initiative. For each, give:\n   * **Name** (short label)\n   * **Who\'s on it** – Names or roles mentioned. If unclear, say "Not specified."\n   * **Wins** – Recent progress, shipped items, unblocks, or positive signals. Bullets. If none in notes, say "None in notes."\n   * **Blockers** – What\'s stuck, waiting on, or delayed. Bullets. If none, say "None in notes."\n   * **Risks** – What could go wrong, at-risk timelines, dependencies, or concerns raised. Bullets. If none, say "None in notes."\n\nOrder by importance or risk if the notes suggest it; otherwise keep a consistent order. Every in-flight initiative must appear; do not omit any. If the notes only mention one or two initiatives, still use this structure so the format stays the same next time.\n\nKeep it tight. The reader should be able to scan this in under two minutes and know where to dig in or who to follow up with.\n\n# Things I care about most\n\n* A complete list: every in-flight project or initiative that shows up in the notes, with none left out\n* Who is responsible or involved for each\n* Wins (so we can reinforce and unblock)\n* Blockers (so we can clear them)\n* Risks (so we can act before they blow up)\n\nTell me like you\'re writing a status email for a busy exec. Information-dense, no filler. Have a point of view when the notes support it.',
		scenarios: ['across'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:List-outstanding-items',
		title: 'List Outstanding Items',
		description:
			'Extracts all open action items, commitments, and deferred questions from meeting notes into a scannable checklist.',
		prompt:
			"# Job\n\nYour job is to extract every open item from the meeting notes: what we said we'd do, what they said they'd do, and any deferred questions or decisions. You are producing a single list so someone can see at a glance what's still outstanding. Use only what's in the notes. Be clear and scannable.\n\n# Rules\n\n**Include only items that are still open.** If the notes say something was done or resolved, don't list it. When in doubt, include it and keep the wording neutral (e.g. \"Follow up on X\").\n\n**Stick to the notes.** Do not invent commitments. If nothing was said about a category (e.g. no \"their\" commitments), that section can be empty or say \"None in notes.\"\n\n**Add context when it helps.** For each item, one short line of context or a date/meeting is enough. No long paragraphs.\n\n# Format\n\n1. **Our commitments** – What we said we'd do (and that hasn't been closed in the notes). Bullet list. For each: what we said we'd do, and when/where if you have it.\n\n2. **Their commitments** – What they said they'd do or send (and that we're still waiting on). Bullet list. Same: what they said, and when/where if you have it.\n\n3. **Deferred / open** – Questions that were left open, or decisions that were punted. Bullet list. One line each.\n\nKeep it tight. No intro, no summary. Just the lists. If a section has nothing, write \"None in notes.\"\n\n# Things I care about most\n\n* Every open commitment from our side\n* Every open commitment from their side\n* Deferred decisions or questions that need an answer\n* Enough context (or meeting/date) to follow up\n\nTell me like you're building a checklist. Just the items, no filler.",
		scenarios: ['across'],
		icon: 'list-checks',
		source: 'imported',
	},
	{
		id: 'imported:Prep-next-meeting',
		title: 'Prep Next Meeting',
		description: 'Generates a pre-call cheat sheet for a meeting based on provided notes.',
		prompt:
			"# Job\n\nYour job is to turn the meeting notes provided into a short brief and talking points for the *next* interaction with this person or account. You are prepping someone so they can walk in clear on context, open loops, and what to cover. Use only what's in the notes. Be clear, scannable, and actionable.\n\n# Rules\n\n**Use only information from the notes.** Do not invent commitments, sentiment, or history. If something wasn't said, write \"Not in notes\" or skip it.\n\n**Focus on the upcoming meeting.** Pull out what's still open, what we said we'd do, what they said they'd do, and what's worth bringing up again. Skip closed threads unless they're useful context.\n\n**Order talking points by priority.** Lead with follow-ups and open loops, then new topics or updates. Put the most important or time-sensitive items first.\n\n# Format\n\n1. **Brief** – 2–4 sentences: where we left off, relationship temperature, and the main open loops. Enough that someone can read this right before the call and feel oriented.\n\n2. **Outstanding items** – Bullet list of unclosed commitments:\n   * What we said we'd do (and haven't yet)\n   * What they said they'd do (worth following up on)\n   * Open questions or decisions that were deferred\n\n3. **Talking points** – Bullet list of what to cover, in suggested order. Include:\n   * Follow-ups to close the loop\n   * Updates we should share\n   * Topics or questions to raise\n   * Anything that was left hanging and needs a resolution\n\n4. **Questions to ask** – If the notes suggest specific questions that would be valuable, list them. Otherwise skip this section or write \"None specified.\"\n\n5. **Handle with care** (optional) – Only if the notes suggest sensitivities, past friction, or topics to avoid. One or two short bullets. Otherwise skip.\n\nKeep it tight. The reader should be able to scan this in under a minute and know what to do in the meeting.\n\n# Things I care about most\n\n* Where we left off and what's still open\n* Commitments from both sides that haven't been closed\n* Talking points in a sensible order (follow-ups first)\n* Questions that would move the relationship or deal forward\n* Any sensitivities or landmines from past conversations\n\nTell me like you're writing a pre-call cheat sheet for a colleague. Actionable, no filler.",
		scenarios: ['across'],
		icon: 'calendar',
		source: 'imported',
	},
	{
		id: 'imported:Assess-company-health',
		title: 'Assess Company Health',
		description:
			'Turns meeting notes into an account brief covering customer overview, relationships, current state, future sentiment, risks, buying process, decision criteria, goals and next steps.',
		prompt:
			'# Job\n\nYour job is to turn the meeting notes provided into a single account brief: who this customer is, how the relationship stands, where the risk is, and what we should do next. You are briefing a colleague who needs to get up to speed or prepare for the next touchpoint. Use only what\'s in the notes; if something isn\'t there, say "unknown" or "not mentioned" instead of guessing. Be clear, scannable, and opinionated.\n\n# Rules\n\n**Use only information from the notes.** Do not invent facts, dates, or sentiment. If renewal or contract timing is mentioned, use the *upcoming* cycle (e.g. next renewal), not a past one. When something is unclear, say so and briefly explain what the conversations suggest.\n\n**Include explicit and inferred goals.** Explicit = stated in the notes. Implied = reasonable inference from tone, questions, or repeated themes. Label which is which.\n\n# Format\n\nProduce these sections in order:\n\n1. **Overview** – Short account bio: tenure, industry/context, any useful culture or situational detail for someone owning the relationship.\n\n2. **Key relationships** – Who we work with (champion, economic buyer, other stakeholders). What role each plays and how engaged they seem.\n\n3. **Current state** – Usage, adoption, and health. What\'s working, what\'s not. Concerns or pain points that came up (cost of inaction, metrics that matter to them).\n\n4. **Forward-looking sentiment** – For the *next* contract or renewal: what do the notes suggest? Optimistic, at risk, unknown? If unknown, give a short read on what the conversations point to.\n\n5. **Risk assessment** – Why they might churn or downgrade. Full exit vs. reduction in scope. Any competition or alternatives mentioned.\n\n6. **Budget, timeline, and buying process** – When they buy or renew, how decisions get made, who signs off, funding sources if mentioned. Procurement or legal steps if relevant.\n\n7. **Decision criteria** – What they use to evaluate success or decide to stay/expand (if stated or implied in the notes).\n\n8. **Next steps** – Where we should focus energy to drive success and reduce risk. Concrete, not generic.\n\n9. **Explicit goals** – Bullet list of stated goals or definitions of success for this account.\n\n10. **Implied goals** – Bullet list of goals inferred from conversations (label as implied).\n\nKeep each section tight. Skip a section only if the notes truly have nothing relevant; then write "Not in notes." Lead with what matters most for the relationship.\n\n# Things I care about most\n\n* Who the champion and economic buyer are, and how solid the relationship is\n* Pain, risk, and competition (why they might leave or shrink)\n* Renewal/expansion sentiment for the *upcoming* cycle only\n* Budget timeline, process, and who has authority\n* What success looks like for them (explicit and implied)\n* Actionable next steps\n\nTell me like you\'re briefing a colleague before a call. Information-dense, no filler. Have a point of view when the notes support it.',
		scenarios: ['across'],
		icon: 'git-branch',
		source: 'imported',
	},
	{
		id: 'imported:summarize-this-folder',
		title: 'Summarize This Folder',
		description:
			"Summarizes a folder's contents, highlighting recurring themes, priorities, and feedback for a quick understanding.",
		prompt:
			"# Job\n\nYour job is to summarize the contents of this folder and surface what keeps coming up: recurring themes, feedback, and priorities. You are briefing someone who wants to quickly understand what's in here and what actually matters, not read everything. Be clear, scannable, and opinionated about what's important.\n\n# Rules\n\n**Include:**\n* A short overall summary of what this folder is about (2–4 sentences)\n* Recurring themes: topics, ideas, or questions that show up again and again\n* Priorities: what people are focused on, what's being pushed, what keeps getting mentioned as important\n* Recurring feedback: patterns of praise, concern, or requests that appear across the notes\n\n**Exclude:**\n* One-off details that don't connect to bigger themes\n* Every single meeting or note; synthesize instead of listing\n* Stuff that doesn't help someone answer \"what's in here and what should I care about?\"\n\n**If the folder is thin or one-note:** Say so. Don't inflate. A short summary plus \"limited content so far\" is fine.\n\n# Format\n\n1. **Summary** – What this folder is about and what's going on (2–4 sentences).\n2. **Recurring themes** – Bullet the themes that show up across the notes. One line each, maybe with a brief \"why it matters\" if it's not obvious.\n3. **Priorities** – What's clearly in focus or being pushed. Again, bullets.\n4. **Recurring feedback** (if any) – Patterns of feedback, concerns, or asks that repeat. Skip this section if there aren't clear patterns.\n\nKeep it tight. Lead with what would help someone get oriented. No filler.\n\n# Things I care about most\n\n* What this folder is actually about\n* Themes that keep coming up\n* What people are prioritizing or stressing\n* Recurring feedback (praise, concerns, requests)\n* Enough context to decide \"do I need to dig into this folder or not?\"\n\nTell me like you're explaining to someone who just opened the folder. Information-dense, not a list of every note.",
		scenarios: ['across'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:List-key-decisions',
		title: 'List Key Decisions',
		description: 'Extracts key decisions from recent team notes to brief absent members.',
		prompt:
			'# Job\n\nYour job is to extract key decisions from the team notes provided from the last 7 days. You are briefing someone who was away or just joined so they know what\'s already decided and don\'t reopen closed questions. Be clear, scannable, and opinionated about what actually matters.\n\n# Rules\n\n**What counts as a decision (include these):**\n* We committed to a direction (product, go-to-market, process)\n* We explicitly said no to something, and why\n* We assigned ownership (who\'s responsible for what)\n* We locked in a date or milestone\n* Anything that would change if we reversed it\n\n**What does not count (exclude these):**\n* "We discussed X" or "we\'ll look into Y" with no commitment\n* Strong opinions that weren\'t agreed by the group\n* Small operational choices unless people keep asking about them\n\n**If unclear:** If something might be a decision or just a strong view, include it but say so (e.g. "Unclear if decided: ...").\n\n# Format\n\nFor each decision give:\n1. **What we decided** (one line)\n2. **Context** (why it matters, 1–2 sentences)\n3. **When** (meeting name or date if you have it)\n\nLead with the decisions that most affect alignment and "did we already decide this?" Keep it tight. Skip the rest.\n\n# Things I care about most\n\n* Commitments that change what we do or how we work\n* Clear no\'s and the reason\n* Who owns what\n* Dates or milestones we\'re committed to\n* Traceability (when/where it was decided)\n\nTell me like you\'re explaining to someone who just got back. Not a board report. Information-dense, no filler.',
		scenarios: ['across'],
		icon: 'git-branch',
		source: 'imported',
	},
	{
		id: 'imported:catch-me-up',
		title: 'Catch Me Up',
		description:
			'Provides a concise, informal, and opinionated summary of key company events from the past week, focusing on significant developments and team sentiment.',
		prompt:
			"# What's been happening?\n\nCatch me up on the last 7 days across the company like you're someone who actually pays attention to what's going on. Give me a friendly, detail-oriented update. \n\nI want the real story - what moved, what's stuck, what people are buzzing about or stressed about. Skip the stuff that doesn't matter.\n\n# Things I care about:\n* Anything that shipped or got decided\n* Deals closing or falling apart\n* Technical breakthroughs or disasters\n* Team energy shifts\n* Money stuff that actually moves the needle\n\nTell me like you're explaining it to someone who was out for a week, not writing a board report. Lead with what actually matters most. Connect the dots. Have an opinion about whether something is a big deal or not. \n\nKeep it tight and information-dense - I want the highlights that would come up if I grabbed coffee with someone plugged in. You don't need to write about every little thing that happened.",
		scenarios: ['across'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:blind-spots',
		title: 'Blind Spots',
		description:
			'Analyzes meeting notes to identify risks, concerns, blind spots, and attack vectors, providing mitigations and questions.',
		prompt:
			'<role>\n  You are a critical analysis assistant with access to meeting notes and transcripts. When called upon, you identify potential issues, failure modes, and vulnerabilities in plans, proposals, or designs that have been discussed.\n</role>\n\n<core_functions>\n  <risk_analysis>\n    Review the discussed plans, strategies, designs, or proposals and:\n    - Identify potential failure points\n    - Surface edge cases that may not have been considered\n    - Highlight dependencies that could break\n    - Point out assumptions that might be wrong\n    - Flag resource constraints or bottlenecks\n    - Note areas where you\'re uncertain but see potential risk\n  </risk_analysis>\n\n  <adversarial_perspective>\n    Adopt relevant adversarial viewpoints based on what was actually discussed. Examples (choose/adapt as appropriate; invent new ones if needed):\n    - Technical systems: hacker, malicious insider, system failure\n    - Business strategies: competitor, market disruptor, economic downturn\n    - Processes: Murphy’s Law, human error, cascading failures\n    - Communications: hostile media, skeptical stakeholders, misinterpretation\n    - Financial plans: auditors, bear markets, unexpected costs\n    - Legal matters: opposing counsel, regulators, litigation risks\n  </adversarial_perspective>\n\n  <constructive_challenges>\n    Generate specific questions and challenges tailored to the meeting content. Use patterns like:\n    - "What if [key assumption] proves false?"\n    - "How would this handle 10x scale?"\n    - "What if [critical dependency] becomes unavailable?"\n    - "How could this be intentionally misused?"\n    - "What blind spots might exist?"\n  </constructive_challenges>\n\n  <solution_oriented_feedback>\n    For issues identified:\n    - Suggest specific mitigations where possible (embed briefly within bullets if helpful)\n    - Recommend validation steps or tests\n    - Propose fallback plans or redundancies\n    - Identify additional expertise needed\n    - Distinguish critical issues from minor concerns\n  </solution_oriented_feedback>\n</core_functions>\n\n<output_requirements>\n  <format>\n    Produce **Markdown**, not XML. Use numbered section headers exactly as specified below (e.g., "## 1. 🚨 Critical Risks").\n    Within each section, use **lettered bullets** (`a)` .. `e)`) so each item can be referenced like `1a`, `3c`.\n    If a section has more than 5 applicable items, include only the top 5 by expected impact × likelihood and add a final italic note stating items were prioritized.\n  </format>\n  <sections>\n    1. 🚨 Critical Risks\n    2. ⚠️ Moderate Concerns\n    3. 🤔 Uncertain but Worth Considering\n    4. 🔍 Possible Blind Spots\n    5. 🎯 Attack Vectors\n    6. 🧭 Dig Deeper (user prompt)\n  </sections>\n  <empty_sections>\n    If an entire section has no content, include the header with a single lettered bullet: `a) None noted.`\n  </empty_sections>\n  <bullet_style>\n    Use concise bullets (1–2 sentences each), tailored to the provided meeting content. Bullets must be lettered in order: `a)`, `b)`, `c)`, `d)`, `e)`.\n  </bullet_style>\n</output_requirements>\n\n<analysis_guidance>\n  - Be direct but constructive; the goal is to strengthen plans.\n  - Express uncertainty when you have it (e.g., "I\'m not certain, but…").\n  - Consider immediate and long-term implications.\n  - Account for human factors as well as technical/logical ones.\n  - Base all analysis strictly on the supplied meeting artifacts.\n</analysis_guidance>\n\n<constraints>\n  - **Hard limit:** maximum 5 bullets per section (letters `a)` through `e)`), can be fewer.\n  - Prioritize by severity and likelihood; prefer specificity over generalities.\n  - Avoid generic boilerplate—ground every point in the provided content.\n</constraints>\n\n<response_schema>\n  The response MUST be Markdown with these sections in this order and with this exact numbering/lettering convention:\n\n  1) ## 1. 🚨 Critical Risks\n     - a) ...\n     - b) ...\n     - c) ...\n     - d) ...\n     - e) ...\n     _If more items exist, end with: "*Prioritized top items; additional risks available on request.*"_\n\n  2) ## 2. ⚠️ Moderate Concerns\n     - a) ...\n     - b) ...\n     - c) ...\n     - d) ...\n     - e) ...\n\n  3) ## 3. 🤔 Uncertain but Worth Considering\n     - a) ...\n     - b) ...\n     - c) ...\n     - d) ...\n     - e) ...\n\n  4) ## 4. 🔍 Possible Blind Spots\n     - a) ...\n     - b) ...\n     - c) ...\n     - d) ...\n     - e) ...\n\n  5) ## 5. 🎯 Attack Vectors\n     - a) ...\n     - b) ...\n     - c) ...\n     - d) ...\n     - e) ...\n\n  ## 🧭 Dig Deeper\n     **Questions? Want me to elaborate on anything?**\n\n     I can drill deeper, suggest mitigations, provide examples, or help prioritize what to tackle first.\n</response_schema>\n\n<execution_instructions>\n  1) Read all the content and context (all meeting notes and transcripts) provided.\n  2) Select appropriate adversarial lenses and perform risk analysis.\n  3) Populate each required section with 1–5 tailored, lettered bullets (`a)`..`e)`) grounded in the provided content.\n  4) If more than 5 items arise for a section, include only the top 5 and add an italic prioritization note.\n  5) Output Markdown only.\n</execution_instructions>',
		scenarios: ['after', 'across'],
		icon: 'help-circle',
		source: 'imported',
	},
	{
		id: 'imported:Pain-Point-To-Linkedin-Brief',
		title: 'Pain Point To Linkedin Brief',
		description: 'Turns customer frustrations into a designer brief for a LinkedIn post.',
		prompt:
			'A meeting just finished where a customer or prospect shared a frustration or pain point. Your job is to turn that pain point into a clear designer brief for a LinkedIn post.\n\nRules:\n- Identify the core frustration expressed in the meeting\n- Write the brief so a designer can create a visual post without needing more context\n- Keep the tone relatable and human, not corporate\n- The post should make the target audience feel seen, not sold to\n- No hashtags or emojis in the brief\n- Do not include anything the customer did not explicitly say or imply\n\nBrief structure:\n\nPain point: [One sentence describing the frustration in the customer\'s own words or closely paraphrased]\n\nTarget audience: [Who feels this pain]\n\nEmotion to evoke: [What the reader should feel when they see the post—e.g., "finally, someone gets it"]\n\nSuggested headline: [A short, punchy line for the visual—under 10 words]\n\nSupporting text: [2-3 sentences expanding on the frustration, written as if speaking directly to the audience, verbatim of the meeting only]\n\nVisual direction: [A simple suggestion for the designer—e.g., "split screen showing expectation vs reality" or "single bold quote on dark background"]\n\nIf no clear pain point was discussed in the meeting, output only: "No pain point identified in this meeting."',
		scenarios: ['before', 'during', 'after'],
		icon: 'users',
		source: 'imported',
	},
	{
		id: 'imported:Crunched-2025-Roast-Me',
		title: 'Crunched 2025 Roast Me',
		description:
			"Generates a light-hearted and affectionate roast based on a person's 2025 meetings and transcripts.",
		prompt:
			"You are to create a light-hearted, affectionate, and good-natured roast about a person based on their 2025 meetings and meeting transcripts. The tone should be warm, humorous, and endearing—never mean-spirited, personal in a harmful way, or insulting. It also shouldn't be sycophantic or cloying.\n\nFollow these instructions:\n\nRead and synthesize the themes, quirks, repeated phrases, habits, and personality traits that appear in the person’s 2025 meetings and transcripts.\n\nBase the roast only on professional behaviors, meeting moments, mannerisms, work habits, and harmless idiosyncrasies that appear in the material.\n\nKeep the roast gently teasing, supportive, and uplifting. The goal is to make the person laugh and feel appreciated, not attacked.\n\nAvoid commentary on physical appearance, identity traits, or anything sensitive.\n\nDeliver the roast in 2-3 short paragraphs, with a breezy, comedic rhythm and a wholesome payoff at the end. Prefer simple, easy-to-read sentences over verbosity. Please break your response into paragraphs for readability and share-ability.",
		scenarios: ['across'],
		icon: 'smile',
		source: 'imported',
	},
	{
		id: 'imported:Crunched-2025-Talent',
		title: 'Crunched 2025 Talent',
		description:
			'Surfaces a surprising self-insight from meeting transcripts with supporting evidence and a humorous quip.',
		prompt:
			'From the user’s 2025 meeting transcripts, surface exactly one surprising insight the user may not realize about themselves. Use only direct evidence from the transcripts — quotes, actions, or observable behaviours — with no interpretation or inference. Combine the evidence into a single concise paragraph describing the pattern you’re highlighting. End the paragraph with a short, funny quip that playfully underscores the insight.',
		scenarios: ['across'],
		icon: 'smile',
		source: 'imported',
	},
	{
		id: 'imported:Crunched-2025-Catchphrase',
		title: 'Crunched 2025 Catchphrase',
		description:
			"Generates a light-hearted, positive, and gently teasing summary of a user's meeting personality and catchphrase for the year based on their 2025 meeting transcripts.",
		prompt:
			'Prompt:\nAnalyze the user’s 2025 meetings and meeting transcripts to identify their characteristic behaviors, tendencies, quirks, and overall meeting personality. Using only this material, generate a light-hearted, positive, and gently teasing summary that fits the following structure:\n\nYou must reply with something in the following format:\n\n"Because you\'re [meeting personality description / behavior], we think your catchphrase for this year was\n\n**[catchphrase]**\n\nTypically said [in this context]."\n\nInstructions:\n\nThe personality description should be humorous, affectionate, and accurate to the meeting materials—never mean-spirited.\n\nThe catchphrase should sound like something the user would plausibly say based on the transcripts.\n\nThe “typically said in this context” line should describe the kind of situation in meetings where the user tends to use that phrase (e.g., defusing tension, moving things along, making a joke, refocusing the team).\n\nAvoid sensitive topics, appearance, or anything personal beyond work habits and meeting style.\n\nKeep it warm, clever, and fun.',
		scenarios: ['across'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:define-your-supergoal',
		title: 'Define Your Supergoal',
		description:
			'Guides a user through co-creating a SuperGoal and then generates a muesly recipe for it. Read the blogpost that inspired the Recipe here: https://mignano.medium.com/the-power-of-supergoals-732d2e00dcbf ',
		prompt:
			"Your role: Act as my thought partner and guide me through a live conversation to co-create a SuperGoal.\n\nA SuperGoal is a single, high-stakes goal that unites a team when everything is on the line. It has an urgent timeframe, one clear metric, and an open-ended path to get there — it’s the “grow or die” kind of goal.  \n\nUse short, conversational prompts. Don’t dump everything at once — move step by step.  \n\n---\n\nBefore starting, say hi, and introduce the idea of SuperGoals: \n\n\"A SuperGoal is a high stakes, focusing goal for a team. It has a clear and urgent timeframe, an open-ended method of achievement, and a single measure of success that everyone can understand.\"\n\nThen explain you're going to work with me to identify a Supergoal for your \n\n**Step 1: Define the problem**  \n- Ask me to describe the problem we’re facing.  \n- Probe for why it’s existential (what happens if we don’t solve it).  \n- Reflect my answer back briefly so we’re aligned before moving on.  \n\n---\n\n**Step 2: Brainstorm candidate SuperGoals**  \n- Generate 2–3 possible SuperGoals based on the problem I shared.  \n- For each one, comment quickly on how it stacks against the 3 criteria:  \n  1. Urgent timeframe  \n  2. Open-ended method  \n  3. Single clear metric  \n- Ask me: *“Which one feels closest? Should we refine or try more options?”*  \n\n---\n\n**Step 3: Narrow down**  \n- Based on my feedback, refine or propose new options.  \n- Encourage me to upvote/downvote and explain why.  \n- Push until we land on **one** SuperGoal.  \n\n---\n\n**Step 4: Confirm & commit**  \n- Restate the chosen SuperGoal in this format:  \n  *“SuperGoal: Achieve [metric] by [date] to ensure [existential outcome].”*  \n- Ask me to confirm or tweak wording.  \n\n---\n\n**Step 5: Create a Granola Recipe**  \n- Once confirmed, ask me:  \n  *“Want me to create a Recipe for Granola that will remind you of your SuperGoal so you can use it in your daily meetings? You'll have to copy the response, open up All Recipes and add it to your Recipe list. After that, we can brainstorm ideas about how achieve your SuperGoal”*  \n- If yes, draft a lightweight and helpful recipe that reads a meeting transcript and then analyzes it to understand how the meeting helps you achieve the active SuperGoal. Only respond with the recipe, do not introduce it or tail it off. This is the only time you do not need to end with a question. \n\n---\n\n**Step 6: Open ideation on execution**  \n- Prompt me: *“If this is our SuperGoal, what’s one wild idea you’d try to get us there? Or I can suggest some if you'd prefer?”*  \n- Add 2–3 ideas from “team members” in different roles (e.g. product, design, growth) as a thought starter.  \n- Keep it scrappy — remind me the how is open-ended.  \n\n---\n\n**Tone & Output Rules**  \n- Always write like we’re in a live workshop: short, energetic, back-and-forth.  \n- When asking clarifying questions, always number any potential solutions you suggest, so the user can indicate their preference easily\n- End each step with **one single clear question back to me** so the conversation continues.  \n- Never jump ahead until I respond.",
		scenarios: ['across'],
		icon: 'list-checks',
		source: 'imported',
	},
	{
		id: 'imported:joke',
		title: 'Joke',
		description:
			'Generates a situational joke, anecdote, or fun fact to ease tension and make a call more personable.',
		prompt:
			'Based on what this person (who I’m speaking to right now) said just now, give me a situational joke or a funny anecdote or a fun fact that I could say right now to ease the tension, make the call more memorable and personable.',
		scenarios: ['before', 'during', 'after'],
		icon: 'smile',
		source: 'imported',
	},
	{
		id: 'imported:affirm',
		title: 'Affirm',
		description:
			'Generates 1-sentence responses to affirm prospects and build rapport during sales calls.',
		prompt:
			"Step into the role of an experienced Sales expert and professional Consultant with a successful track record of securing responses and meetings with prospects through relatable, conversational outreach that feels human, affirms the target audience's needs and concerns, is honest, and identifies the target audience's needs perfectly. Based on what my prospect (who I’m speaking to right now) said so far during this call, give me 1-sentence comments or responses to say to them - ensure that I am reaffirming them to make them feel seen & heard. The goal here is to maximise my chances of successfully closing them as my client and building a value-based relationship. I want them to generate warmth and rapport that is natural, human, and peer-to-peer, mirroring the prospect’s energy, celebrating their wins (if any were shared), reassuring worries (if any were shared) and keeping the momentum to lead all the way to the close.",
		scenarios: ['before', 'during', 'after'],
		icon: 'file-text',
		source: 'imported',
	},
	{
		id: 'imported:sales-questions',
		title: 'Sales Questions',
		description:
			'Generates targeted sales questions and compelling outreach language to close clients.',
		prompt:
			"Step into the role of an experienced Sales expert and professional Consultant with a successful track record of securing responses and meetings with prospects through relatable, conversational outreach that feels human, affirms the target audience's needs and concerns, is honest, and identifies the target audience's needs perfectly. Based on what my prospect (who I’m speaking to right now) said so far during this call, give me targeted questions I could ask them, followed by compelling and assumptive yet not presumptuous and not sales-y language. The goal here is to maximise my chances of successfully closing them as my client and building a value-based relationship. Draw on the styles of Jordan Belford, Shelby Haas, Alex Hormozi, Brian Tracy, and other sales experts who have mastered the art of selling in a natural, human way, one that does not feel robotic or fake.",
		scenarios: ['before', 'during', 'after'],
		icon: 'help-circle',
		source: 'imported',
	},
	{
		id: 'imported:state-of-me',
		title: 'State Of Me',
		description: 'Generates a weekly status update for a direct report to their manager.',
		prompt:
			'Generate a weekly **State of Me** update for a direct report to share with their manager. The goal is to surface blockers, priorities, and forward-looking topics in a **scannable way** that builds visibility, prevents surprises, and ensures recognition.\n\n---\n\n### Instructions\n\n- Analyze the **past two business weeks.**\n    \n- Always produce **three numbered sections**: **1. Blockers I need help with**, **2. My current priorities**, **3. On my mind**.\n    \n- Each section should use **bullets**, with short, **verb-first lines**.\n    \n- Use the person’s own words where possible.\n    \n- If uncertain, tag as `[PLEASE VERIFY: detail]`.\n    \n- If inferred, tag as `[INFERRED: basis]`.\n    \n- If any tags exist, append a **⚠️ Review** section at the end.\n    \n- Keep output **concise and written for a human to read** — the goal is clarity, not completeness.\n\n- **Prioritize the most recent 5 business days** for blockers, priorities, and thoughts.\n    \n- Include older items (up to two weeks) **only if they remain active, unresolved, or directly relevant**.\n    \n- Drop completed or outdated context, even if mentioned in transcripts.\n    \n- Always highlight **new developments since the last update** so the manager sees progress.\n    \n\n### Date Handling Best Practice\n\n- **Anchor to today:** Treat today’s date as the fixed point.\n    \n- **Normalize meeting references:** If a transcript says “today,” “yesterday,” or a weekday, resolve it to the actual calendar date of that meeting.\n    \n- **Check for completion:** Assume tasks or blockers mentioned more than ~7 business days ago may already be done unless they show up again as unresolved.\n    \n- **Prioritize freshness:** Always surface what’s new since the last update; include older items only if they remain clearly active.\n\n---\n\n### Context rules\n\n- Weight internal meetings (1:1s, standups, reviews) more than external calls.\n    \n- Always include manager meetings if present.\n    \n- Synthesize across conversations where the manager wasn’t present.\n    \n- For external calls, include if relevant to blockers/priorities.\n    \n\n---\n\n### Section guidelines\n\n**1. Blockers I need help with**\n\n- Look for mentions of “blocked, stuck, waiting on, dependency, approval.”\n    \n- Always specify **who can help** and, if possible, **by when**.\n    \n\n**2. My current priorities**\n\n- Identify **active projects and initiatives**.\n    \n- Note **progress, milestones, deadlines**.\n    \n- Highlight if a **decision or action** is needed from the manager.\n    \n\n**3. On my mind**\n\n- Capture **forward-looking items**: early risks, upcoming PTO, team/process notes.\n    \n- Keep phrasing close to the person’s own language.\n    \n\n---\n\n### Output formatting\n\n- Use **Markdown headings** (e.g., **Blockers I need help with**).\n    \n- Use * for bullet points.\n    \n- Leave a blank line between sections.\n    \n- Keep it concise and professional.\n    \n\n---\n\n### Default email output\n\n**Subject:** Weekly update – [Current week dates]\n\nHi [Manager name],\n\n**1. Blockers I need help with:**\n\n- [Blocker 1: description + WHO + WHEN]\n    \n- [Blocker 2: …] [PLEASE VERIFY/INFERRED if applicable]\n    \n\n**2. My current priorities:**\n\n- [Project/initiative]: [Progress + milestone/deadline]\n    \n- [Project/initiative]: … [PLEASE VERIFY/INFERRED if applicable]\n    \n\n**3. On my mind:**\n\n- [Topic 1: forward-looking issue, risk, or idea]\n    \n- [Topic 2: …]\n    \nThanks, \n[my name]\n\n**⚠️ Review (only if tags exist):**\n\n- [PLEASE VERIFY: item] – [explanation]',
		scenarios: ['across'],
		icon: 'calendar',
		source: 'imported',
	},
	{
		id: 'imported:Pipeline-prep',
		title: 'Pipeline Prep',
		description:
			'Summarizes key deal updates, risks, and progress for a sales pipeline review meeting',
		prompt:
			"I'm an AE reporting into my team and sales leader in a deal pipeline review. Based on the call notes provided, your job is to help me prepare for this meeting by reminding me of key updates / risks from calls i've had since last week. This should be a short update - no longer than 300 words.\n\nThis is the format the I give updates within: \n* Current quarter forecast (Commit 90% / Best Case 75% / Pipeline 50%)\n* Top 2–3 strategic (deals that feel likely to close in the next 2 weeks with a deal size above $10k) deals (stage, risks, next steps, support needed)\n* Changes from last week (slipped, progressed, new champions, procurement updates)\n\nFocus on:\n- Agreed due outs per deal meetings (what we've committed to)\n- Who I met with \n- Procurement updates and what's left in the process\n- Any support that I might need \n\n<example>\n\n**Top strategic deals**\n\n**1) Acme Corp – $75k (Stage: Contracting)**\n\nMet with VP of Operations and Procurement lead last Thursday.\n\nAgreed to provide revised redlines by EOD today. Procurement has requested final security questionnaire, which is in progress with our IT team.\n\nRisks: Timing risk if procurement pushes approval to next quarter.\n\nNext steps: Send redlines today, schedule legal review call early next week.\n\nSupport needed: Legal team to prioritize review turnaround.\n\n**Northwind – $42k (Stage: Negotiation)**\n\nCall with CIO and Finance Director on Tuesday; confirmed technical fit.\n\nAgreed due out: Share updated pricing proposal including tiered discount structure.\n\nRisks: CFO wants additional ROI validation before sign-off.\n\nNext steps: Deliver updated proposal by Friday, schedule follow-up ROI session next week.\n\nSupport needed: Finance partner to help refine ROI model.\n\n**Globex – $18k (Stage: Evaluation)**\n\nSpoke with new champion (Head of Customer Success).\n\nProcurement has confirmed we’re in vendor onboarding queue, pending legal review.\n\nNext steps: Meeting next week",
		scenarios: ['across'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:build-unspoken-company-culture-handbook',
		title: 'Build Unspoken Company Culture Handbook',
		description: 'Summarizes company culture in an easy to read handbook',
		prompt:
			'Describe our culture based on all of my company meetings over the last couple of weeks. Write the handbook of all of the tacit unsaid things about we work and the roles different people play. Be insightful, honest, practical.',
		scenarios: ['across'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:create-a-recipe',
		title: 'Create A Recipe',
		description: 'Helps create repeatable, high-frequency muesly Recipes from meeting transcripts',
		prompt:
			"Your task: Help me quickly create repeatable, high-frequency Recipes for my work in Granola. \n\nA Recipe is a shortcut prompt that makes transcripts instantly useful. It’s repeatable, not a one-off summary, and only outputs text content. It is not an agent. \n\n---\n\n**Step 1: Suggest Recipes**  \n- Please analyze my total work context, understand who I am, who I work with and what's important to me. Recognize recurring workflows I might have, frequent to dos that are generated from my meetings and help generate two extremely useful recipes for me. Number them 1 and 2. \n- For each, include:  \n  • A title  \n  • One sentence why it’s useful  \n- Ask me: *“Do either of these sound good? Or should I suggest others?”*  \n\n---\n\n**Step 2: Draft the Recipe**  \n- Take the chosen Recipe and generate a complete draft in copy-pasteable markdown.  \n- Include:  \n  • Title  \n  • Task description  \n  • Input handling rules  \n  • Output format example  \n- Make smart assumptions from my transcripts and context rather than asking me to fill in every detail.  \n\n---\n\n**Step 3: Confirm & Save**  \n- Present the draft Recipe and ask something like: *“Is there anything about this that you would change or is it ready to add to Granola?”*  \n- Once confirmed, tell me how to add:  \n  *“Copy my last response into Granola → All Recipes → New Recipe → Paste → Save.”*  \n\n---\n\n**Tone & Output Rules**  \n- Keep it light, fast, and proactive — don’t overload me with choices.  \n- Default to making inferences from transcripts and my role; only ask for clarification if truly ambiguous.  \n- Always end with one simple question to move forward. \n- Include details from the \n\n---\n# What Makes a Good Recipe\n\nA Recipe is a reusable shortcut that turns meeting transcripts into the exact artifact you need every time.  \n\nA good Recipe should be:  \n\n- **High frequency** → Something you’ll use often (e.g. action items, decisions, prep notes).  \n- **Low frequency but high value** → Even if you only need it occasionally (e.g. board prep, end-of-quarter summaries), the time saved is huge.  \n- **Clear and scannable** → The output should be easy to skim in under two minutes.  \n- **Repeatable** → It works the same way across different meetings, not just once.  \n- **Focused** → Aim for one specific job-to-be-done, not a mix of everything.  \n- **Context-aware** → Written so it filters out irrelevant chatter, and only includes what matters to you.  \n- **Uses Markdown** → formatted for easy reading\n- **Universal, not niche** → Don’t create Recipes tied too closely to one stream of work. Instead, design for high-frequency or broadly useful outputs that make my job easier every day. You can still personalize with my wider work context that would be helpful - like including colleagues’ names, team names, or company-specific roles.  \n- **Scoped correctly** → Recipes should be designed for one of three contexts:  \n  • **Single meeting transcript** (e.g. extract action items)  \n  • **Multiple meetings** (e.g. weekly summaries or trend analysis)  \n  • **Live meetings** (e.g. surface blockers or real-time prep prompts and analysis)  \n\nThink of it as a **shortcut for your future self**: every time you run it, you instantly get the structured output you need, without re-explaining what you want.",
		scenarios: ['across'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:help-me-decide',
		title: 'Help Me Decide',
		description:
			'Applies decision-making frameworks to a stated problem and suggests resources for further exploration',
		prompt:
			'Your task: Act as a no-nonsense decision coach. If a clear problem is given, use it. If not, surface major decisions and define the most important problem. Then select and apply the most fitting decision framework(s) and produce a concise, actionable recommendation with sources.\n\nIt is possible that the user has defined a problem, if so, you will find it at the end of this prompt. Ensure you check that before going ahead. \n\n<logic>\n1a) **If a problem is provided** → use that problem and proceed.  \n1b) **If no clear decision/problem is stated** →  \n   - Identify **at least 3 big decisions** discussed in the notes. Sum them up briefly  \n   - From these, define **the largest, most important problem** to consider (state why).\n   - Ask if I agree, and if not, ask me to define the problem. \n\nYou are an expert, consistent, no-nonsense coach that aids in major business decisions, using frameworks like CSD Matrix, Golden Circle, Decision Graphs, Eisenhower Matrix, SWOT Analysis, and at least 3 other relevant frameworks for decision making. Use this doc and other similar frameworks: https://fourweekmba.com/frameworks-for-decision-making/\nAs appropriate, you should use social science theories such as Prospect Theory, Social Judgment Theory, Diffusion of Innovations Theory, Advocacy Coalition Framework, Cultural Theory, Organizational Decision Making Theories and others. You should draw not just from the frameworks listed but also from other frameworks for business and social science decision-making. Consider the unique nature of this problem and this company when picking the frameworks. For additional frameworks look to magazines like Harvard Business Review, Economist, books, or academic publications. You use online sources for the framework chosen as necessary.\n\nThen report this back:\n\nNow, help me by following the steps below:\n\nFrame the problem being solved: "Problem: "\n\nCite three potential frameworks for deciding with one sentence each describing.\n\nPick one that is the most appropriate for this situation. Then you should take that framework, and go step by step through the decision framework as outlined, using short, direct, conversational talk to define how to find a solution using that framework. These theories are used to inform decisions and provide clarity. The tone and approach remain consistent, regardless of the user\'s business background, emphasizing efficient and informed decision-making.\n\nCite blog posts, youtube videos or other advice that could help go deeper, including URLs for finding solutions to @problem and on using @options\n\n## User defined problem:\nHelp me decide',
		scenarios: ['during', 'after', 'across'],
		icon: 'help-circle',
		source: 'imported',
	},
	{
		id: 'imported:will-it-go-viral',
		title: 'Will It Go Viral',
		description:
			"Evaluates a product idea's viral potential using specific levers and provides a blunt, irreverent assessment",
		prompt:
			"Your task: Judge if this product idea has viral potential. Use Nikita Bier’s levers and terminology. Output must be blunt, irreverent, and in his voice — funny one-liners, no sugarcoating.\n\n<virality_levers>\n- **Latent demand**: Is there proof people already crawl through glass for this value? (e.g. Sarahah #1 in Arabic).  \n- **3-second “aha”**: Does value hit instantly in the pixels, or do you need a tutorial?  \n- **Synchronous density**: Can one tight graph (school, group chat, frat house) be saturated ~3x?  \n- **Positive loops**: Does it multiply messages/interactions in a way that makes people feel good?  \n- **Frictionless invites**: Is there a sneaky, one-tap way to get friends in under iOS 18?  \n- **Social signaling**: Name/icon reduce social risk at the invite moment (e.g. “Gas” flame > “Crush” heart).  \n- **Built-in shareability**: Does it slot into existing behaviors (Snapchat stories, DMs, group chats)?  \n- **Executable test path**: Use → Spread → Hop. Can you run each stage at 100% while half-assing the rest?  \n- **Growth ops**: Can you geofence/throttle when servers break? (They will.)  \n- **Narrative defense**: If a hoax has a higher K-factor than your app, you’re toast. Is there a defense plan?  \n</virality_levers>\n\nFirst ask a question to find out what specifically they'd like feedback on, suggest 1-3 product or marketing ideas from the context or ask them to suggest one. Don't engage in a lengthy back and forth.\n\n<output_format>\n**Will it actually go viral?**  \n- Overall verdict: 1 blunt sentence (e.g. “Nope, this dies on arrival.”)\n\n**Breakdown by lever:**  \n- Latent demand — 1-2 sentences in Nikita’s voice (“Nobody is hacking their way to this. No contortion = no demand.”)  \n- 3-second aha — same tone.  \n- Continue for all 10 levers.\n\n**Biggest blockers:**  \n- Roast 2–3 weakest levers with sharp one-liners (“Your invite flow is DOA. Nobody is scrolling through 500 contacts in 2025.”).  \n\n**Strongest levers:**  \n- Call out 2–3 that actually work, but keep praise backhanded (“The aha is clear. Congrats, you managed not to overcomplicate pixels.”).  \n\n**Bottom line:**  \n- 2–3 sentence irreverent verdict in Nikita’s style. Example: “This doesn’t go viral. It limps into the App Store, racks up 800 pity downloads, then dies quietly. Welcome to the graveyard.”  \n</output_format>\n\nRemember, your job to is provide harsh reality checks in the style of Nikita Bier for me and my idea.",
		scenarios: ['across'],
		icon: 'file-text',
		source: 'imported',
	},
	{
		id: 'imported:create-linear-ticket',
		title: 'Create Linear Ticket',
		description:
			'Extracts product and engineering tasks from meeting transcripts for import into Linear',
		prompt:
			"Your job is to help me create a Linear ticket from this meeting transcript (or from explicit `/create-linear-ticket` commands).  \n- Suggest what ticket should be created, confirm with me, then generate a valid markdown link that opens a pre-filled Linear issue.  \n- If I invoke `/create-linear-ticket` and provide context, bypass transcript analysis and use my input as the source of truth.  \n\n<URL Schemas>\n<Linear>\nBase URL: https://linear.new  \nParameters:  \n- title → issue title (URL-encoded, use + for spaces)  \n- description → issue description (markdown supported; URL-encoded; use %0A for line breaks)  \n- assignee → UUID, display name, or assignee=me  \n- priority → Urgent, High, Medium, Low  \n- status → name or UUID of workflow status  \n- estimate → point value (e.g. 2, 4, 8)  \n- labels → comma-separated labels (URL-encoded if multiple)  \n- project → project name or UUID  \n- cycle → cycle name, number, or UUID  \n- links → URL encoded comma-delimited list of links, with optional titles in format url|title  \n</Linear>\n</URL Schemas>\n\n<Instructions>\nBased on the discussion in this meeting, I need you to help me create a Linear ticket for a **customer-reported issue**.\n\n1. Start by suggesting what ticket(s) should be created.  \n   - Usually suggest just one ticket.  \n   - Keep the suggestion short: a one-line title and one sentence of context.  \n   - Ask me if that sounds right.  \n\n2. If I give you feedback, incorporate it and update the suggestion.  \n\n3. Once confirmed, generate a clickable markdown link called **'Create Linear Ticket'**.  \n   - Use the Linear URL schema with properly URL-encoded parameters.  \n   - Always include at least a **title**.  \n   - Include **description, labels, priority, assignee, project** if obvious from the transcript.  \n   - Leave blank if not clear.  \n\n4. When building the **description field**, pull in details from the transcript only if they are explicitly present. Use structured sections when possible:  \n   - **Customer Impact** → if the transcript names affected customers, number of users, or account value.  \n   - **Steps to Reproduce** → if specific steps are mentioned (numbered list).  \n   - **Expected vs Actual** → if both outcomes are described.  \n   - **Environment** → if browser, device, OS, or version is mentioned.  \n   - **Business Impact** → if there’s mention of lost revenue, blocked workflow, or severity.  \n   - **Workaround** → if a temporary fix is described.  \n   - **Links** → if there’s a support ticket, Slack thread, or external doc mentioned.  \n\n   ➡️ If these are not in the transcript, **do not invent them**. Simply omit the section.  \n\n5. Always return the link as valid markdown. Do not break formatting.  \n   - Example:  \n     [Create Linear Ticket](https://linear.new?title=Password+reset+error&description=Customer+cannot+reset+passwords.%0A%0ACustomer+Impact%3A+Reported+by+3+enterprise+accounts.%0A%0ASteps+to+Reproduce%3A%0A1.+Sign+up+with+email%0A2.+Log+out%0A3.+Try+to+reset+password%0A%0AExpected%3A+Password+reset+link+works.%0AActual%3A+Reset+link+shows+error.&labels=bug,backend&priority=High)  \n\n6. If creating a placeholder issue, mark that clearly in the **title** (e.g. \"[Placeholder] Draft ticket for …\").  \n\n7. Never use quotation marks, always use ' in their place. \n</instructions>\n\n**Direct user-invoked flow**:  \nThe user may explicitly invoke `/create-linear-ticket` and provide their own context (title, description, labels, etc.).  \n   - If so, don't suggest a ticket, base your response on the user-provided context instead.  \n   - Their input should appear here as the source of truth for the ticket content (if blank, disregard this):",
		scenarios: ['during', 'after'],
		icon: 'list-checks',
		source: 'imported',
	},
	{
		id: 'imported:devrelcontent',
		title: 'Devrelcontent',
		description: 'Summarise meetings into a content production plan with a checklist.',
		prompt:
			'Translate meeting notes into a reusable content production plan.\n\nsummarise meetings that feed content strategy. Use markdown sections with bullet points. Explicitly note where I\'m the owner. After Supporting Assets, add a "Production Checklist" numbered list turning every deliverable into a task.\n\nexample:\n\n## Core Theme\n- Upcoming drop: “How to Build a Code Review Bot” with our headless `droid exec`.\n\n## Supporting Assets\n- Docs: "Droid exec Overview" & "Cookbook"\n- Workshop: live coding session.\n\n## Inputs Needed\n- Varin: proper use of droid exec.\n- Eno: validation/tests/run through the flow.\n\n## Production Checklist\n1. [ ] Ben: draft blog outline & share by Friday.\n2. [ ] Ben: coordinate workshop date (target week of 21 Oct).\n3. [ ] Ben: request benchmark charts from Sarah by Wednesday.\n\n## Distribution Experiments\n- Include in Ben\'s Bites\n- Post demo video on X',
		scenarios: ['after'],
		icon: 'scroll-text',
		source: 'imported',
	},
	{
		id: 'imported:schedule-follow-up-meeting',
		title: 'Schedule Follow Up Meeting',
		description: 'Generates a Gmail draft or Google Calendar event based on meeting discussions.',
		prompt:
			'<URL Schemas>\n<Google Calendar>\nURL schema: https://calendar.google.com/calendar/render?action=TEMPLATE&text=TITLE&details=DESCRIPTION&location=LOCATION&dates=START/END\n\nTITLE → event title (URL-encoded)\nDESCRIPTION → event details (optional)\nLOCATION → where the event is happening (optional)\nSTART / END → in YYYYMMDDTHHMMSSZ format (UTC) or YYYYMMDD for all-day\n</Google Calendar>\n\n<Gmail>\nURL schema: https://mail.google.com/mail/?view=cm&fs=1&to=TO&su=SUBJECT&body=BODY&cc=CC&Bcc=BCC\nTO → recipient email(s), comma-separated\nSUBJECT → subject line\nBODY → message text\nCC / BCC → optional, comma-separated addresses\n</Gmail>\n</URL Schemas>\n\n<Instructions>\nBased on the discussion in this meeting, I need you to help me schedule a follow-up meeting. Start by suggesting what follow-up meeting(s) you think would make sense. Most of the time, you should only suggest one option (suggest multiple if the suggestions are very different). Be extremely short here and mention when timeframe might make sense (next week), but don\'t list all the details. Then ask me whether that sounds right. Keep your responses short and fast.\n\nIf I give you feedback, incorporate it. Then do any of the following that make sense: \n- Generate a link called "Draft email with suggested times" that points to a URL that will create a Gmail draft that I can send to the person/people I\'m trying to schedule a meeting with. If it makes sense to suggest specific times, look at my calendar and suggest times where I am free. Use my time zone as the default.\n- Suggest times based on my upcoming meetings that might be good (if you\'re suggesting times to me, mention that I\'m free. Maybe tell me what I have scheduled before/after each suggested time)\n- Generate a link called "Create calendar event" that points to a URL that will create a draft Google calendar event with all meta data filled out. \n\nSome things to note:\n- Always return links as clickable markdown. Be careful not to break markdown formatting in the links you generate.\n- Make sure to URL encode all gmail and calendar links you generate\n- If you create a placeholder event, state that is a placeholder in the title.\n- List any proposed times before creating a Gmail or Calendar link \n</Instructions>',
		scenarios: ['after'],
		icon: 'mail',
		source: 'imported',
	},
	{
		id: 'imported:create-help-doc',
		title: 'Create Help Doc',
		description:
			'Generates a customer-facing help document for a new feature based on meeting transcripts',
		prompt:
			'Your task: Use the transcript from this meeting I just had about a feature to create a customer-facing help article.\n\n<steps>\n1. From the transcript, infer the **feature name** and give a 1–2 sentence description of what it does.  \n   - In your first reply:  \n     • Confirm the inferred feature name.  \n     • Confirm the basic functionality.  \n     • Ask if I’d like to provide a style guide or an example article for format and tone.  \n   - Wait for my confirmation before drafting the article.  \n\n2. When drafting the article, include:\n   - **What the feature does** and **why it’s useful** (1–3 short sentences).  \n   - **Set-up guidance** if required (otherwise skip).  \n   - **Step-by-step instructions** for how to use the feature.  \n   - **Troubleshooting** only if common user issues are likely; skip if not.  \n   - Exclude all internal notes, technical jargon, or details irrelevant to end users.  \n\n3. At the bottom, add a section:  \n   **Recommended screenshots:** [list of screenshots that would help the user understand].  \n\n<output_format>\n- Write as a polished help article: headings, short paragraphs, and bullet lists for steps.  \n- Keep instructions concise, actionable, and easy to scan.  \n</output_format>',
		scenarios: ['after'],
		icon: 'file-text',
		source: 'imported',
	},
	{
		id: 'imported:gather-product-feedback',
		title: 'Gather Product Feedback',
		description:
			'Analyzes customer calls to extract product-related feedback and group it into clear, actionable themes',
		prompt:
			"You are analyzing customer discovery call transcripts for my product.\n\nMy goal is to understand how users respond to my product's features and what that means for what we build next.\n\nInstructions:\n\nFocus only on feedback about my product, its features, or workflows.\n\nDo not include general “state of the world” insights unless they are explicitly tied to a feature request, reaction, or product gap.\n\nGroup insights into clear themes (2–4 words each).\n\nFor each theme:\n- Start the title with a relevant emoji.\n\nShare a list for:\n\n- Quote: Include 1–3 representative quotes about my product as a bullet list. After each, add a brief persona descriptor (e.g. “freelance designer,” “enterprise product lead”).\n\nDesign Implication: Write a robust, actionable takeaway on a fresh line, on what this means for my product — whether we should improve, add, or emphasize a specific feature. Keep implications tied directly to product strategy and list any tradeoffs that might exist.\n\nOrganize quotes under positive reactions, frustrations, or requests when possible.\n\nImportant formatting note:  Format each quote and design implication as separate points under the theme title, which is in bold. \n\n<example>\n\n🗂️ **Feedback Organization**\n\n“Feedback is scattered across links — I want everything in one place” - Agency Designer) (frustrated)\n\n“Can I filter by reviewer type? Internal vs client?” - Enterprise design lead (request)\n\n- **Design Implication**: Your product's “one link” story resonates, but we need to strengthen it with filtering and organization features. Double down on making the link permanent and add grouping tools that reduce scattered feedback noise.\n\n</example>",
		scenarios: ['across'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:What-does-that-mean',
		title: 'What Does That Mean',
		description:
			'Defines technical terms, explains acronyms and helps you understand complex ideas in your current meeting',
		prompt:
			"I'm in a meeting and I don't understand what someone just said. \n\nCan you: \n* Summarise the output of the recent context simply and in bullet points\n* Define any technical terms or explain any acronyms\n* Use human language, do not overcomplicate it\n* Do not introduce the answer, get directly to the point.\n* Use markdown",
		scenarios: ['during'],
		icon: 'sparkles',
		source: 'imported',
	},
	{
		id: 'imported:who-owes-me-what',
		title: 'Who Owes Me What',
		description: 'Generates a list of action items assigned to others that are due today.',
		prompt:
			"What are all the things people I work with said they'd do by today - ie, what are the things that people owe me that I might want to check up on if they haven't sent it? Don't include stuff I need to do",
		scenarios: ['across'],
		icon: 'list-checks',
		source: 'imported',
	},
	{
		id: 'imported:replit-it',
		title: 'Replit It',
		description:
			'Generates a Replit build brief from meeting notes. Copy and paste this into Replit to have it build your idea',
		prompt:
			'Convert the meeting notes into a precise build brief for Replit to create a working \n\n**How to respond:** Output *only* the build brief below. If information is missing, add `TODO:` items and make safe, minimal defaults.\n\n**Build Brief for Replit**\n\n1. **Project Summary (2–3 sentences)**\n    - What we’re building and why (from notes).\n    - Primary user and core value.\n2. **Tech Stack & Repl Type**\n    - Language/framework(s) (backend + frontend if relevant).\n    - Key libraries and SDKs.\n    - Runtime requirements.\n3. **File & Folder Scaffold**\n    - Provide a code-fenced tree (no comments).\n    - Include starter files (app entry, routes, components, config).\n4. **Features & Scope (v0 only)**\n    - Bullet the must-have features extracted from notes.\n    - Call out **Out of scope (v0)** to prevent bloat.\n5. **API & Data Contracts**\n    - Endpoints (method, path, brief behavior, request/response JSON).\n    - Data models/schemas (code-fenced).\n    - External integrations (auth, webhooks, third-party APIs).\n6. **UI Spec (if applicable)**\n    - Pages/views, key components, minimal styling approach (Tailwind/Shadcn if web).\n    - Basic navigation flow.\n7. **Environment & Secrets**\n    - `ENV` variables needed and their purpose.\n    - Any setup notes.\n8. **Commands**\n    - How to install, run dev server, run tests, and build (exact shell commands).\n9. **Test Plan (v0)**\n    - Happy-path checks, at least 3 edge cases, and a simple smoke test script.\n    - Seed/sample data (code-fenced).\n10. **Acceptance Criteria**\n    - Observable behaviors the Repl must satisfy to call v0 “done”.\n11. **Risks & Follow-ups**\n    - Top risks/unknowns.\n    - `TODO:` questions for stakeholders.\n\n**Output rules:**\n\n- Be specific and executable.\n- Prefer minimal, shippable choices over comprehensive ones.\n- Use code fences for trees, schemas, and sample code only.\n- No extra commentary outside the sections.',
		scenarios: ['after'],
		icon: 'file-text',
		source: 'imported',
	},
	{
		id: 'imported:recap-next-steps',
		title: 'Recap Next Steps',
		description:
			'Helps you wrap up a call by summarizing agreed action items and outstanding questions from a meeting',
		prompt:
			'It’s near the end of the meeting and I’d like to wrap up and get confirm next steps. Can you please list out agreed action items with any explicitly mentioned deadlines. Where there is ambiguity or open subjects we absolutely need to confirm, list them below "To confirm". Try to only share the most important actions. \n\nOutput\n## Agreed actions\n* [brief, action focused list, each bullet starts with a verb)\n## To confirm\n* [questions or non-concluded discussions]',
		scenarios: ['during'],
		icon: 'list-checks',
		source: 'imported',
	},
	{
		id: 'imported:make-notes-shorter',
		title: 'Make Notes Shorter',
		description: 'Rewrites meeting notes so they are shorter and more concise',
		prompt:
			'Either rewrite these meeting notes so they are shorter and more concise, or if a section of text is highlighted and has been shared, make just that section shorter and more concise.',
		scenarios: ['after'],
		icon: 'scroll-text',
		source: 'imported',
	},
];

/** Built-in + imported bars. User-created bars come from the DB separately. */
export const CATALOG_BARS: Bar[] = [...BUILTIN_BARS, ...IMPORTED_BARS];

/** Bars offered by a chat surface (per-meeting chat vs the Home chat). */
export function catalogForSurface(surface: ChatSurface): Bar[] {
	const scenarios = SCENARIOS_BY_SURFACE[surface];
	return CATALOG_BARS.filter((b) => b.scenarios.some((s) => scenarios.includes(s)));
}
