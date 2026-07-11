-- Folder organization: one level of nesting (parent_id) and favorites.
-- favorited_at doubles as the favorite flag (NULL = not favorited) and the
-- ordering key for the sidebar's Favorites section.
ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id);
ALTER TABLE folders ADD COLUMN favorited_at TEXT;
