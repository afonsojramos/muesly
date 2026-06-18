-- Add xAI (Grok) API key column to settings table.
-- Named xaiApiKey to keep it visibly distinct from groqApiKey.
ALTER TABLE settings ADD COLUMN xaiApiKey TEXT;
