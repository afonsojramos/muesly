-- Bars carry Granola-style "scenario" tags (before/during/after a meeting, or
-- across meetings) instead of the coarse meeting/global scope, for grouping and
-- filtering. Rename the column; values are re-validated at the app layer.
ALTER TABLE bars RENAME COLUMN scopes TO scenarios;
