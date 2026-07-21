-- Folder memory is implicit: extraction and summary injection are on for every
-- folder, and extracted memories are accepted automatically (no review queue).
-- The Memory section stays for visibility and control (edit/pin/delete), but
-- nothing requires curation. Existing folders and any pending proposals from
-- the opt-in flow are migrated forward.

UPDATE folders SET context_in_summaries = 1 WHERE context_in_summaries = 0;
UPDATE folders SET memory_extraction = 1 WHERE memory_extraction = 0;
UPDATE folder_context_items SET status = 'accepted', updated_at = datetime('now')
    WHERE status = 'pending';
