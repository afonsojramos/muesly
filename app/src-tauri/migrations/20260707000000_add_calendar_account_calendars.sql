-- Cache each Google account's calendar list (JSON array of {id, title}) so the
-- settings page renders from local data instead of a live Google API call on
-- every open. Populated when the account is connected and on an explicit manual
-- refresh; NULL means "never fetched yet".
ALTER TABLE calendar_accounts ADD COLUMN calendars_json TEXT;
