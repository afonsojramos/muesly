import { defineConfig } from 'drizzle-kit';

// Offline SQL generation only (`drizzle-kit generate`); migrations are applied
// to D1 with `wrangler d1 migrations apply` (see package.json scripts).
export default defineConfig({
	dialect: 'sqlite',
	schema: './src/db/schema.ts',
	out: './drizzle',
});
