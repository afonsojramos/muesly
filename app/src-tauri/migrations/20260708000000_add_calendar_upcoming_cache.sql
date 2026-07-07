-- Cache the "Coming up" upcoming-events preview (JSON: events + fetched_at) so the
-- home dashboard paints instantly from local data instead of waiting on a live
-- fetch from the calendar sources (Google network). Served on read; refreshed in
-- the background when older than the TTL.
ALTER TABLE settings ADD COLUMN calendar_upcoming_cache TEXT;
