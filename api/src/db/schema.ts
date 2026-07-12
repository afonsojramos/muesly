import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Anonymous popularity counts for shared catalog bars. No user data, ever. */
export const barUsage = sqliteTable(
	'bar_usage',
	{
		barId: text('bar_id').primaryKey(), // 'builtin:*' or 'imported:*' only
		uses: integer('uses').notNull().default(0),
		updatedAt: text('updated_at').notNull(), // RFC3339
	},
	(t) => ({ usesIdx: index('idx_bar_usage_uses').on(t.uses) }),
);
