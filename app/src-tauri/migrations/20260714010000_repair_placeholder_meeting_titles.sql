UPDATE meetings
SET title = CASE
    WHEN created_at IS NOT NULL AND length(created_at) >= 10
        THEN 'Meeting ' || substr(created_at, 1, 10)
    ELSE 'New Meeting'
END
WHERE replace(lower(trim(title, ' <>[]{}.,:;!?')), '-', ' ') IN (
    'add title',
    'add title here',
    'ai generated title',
    'meeting title',
    'title',
    'untitled'
);
