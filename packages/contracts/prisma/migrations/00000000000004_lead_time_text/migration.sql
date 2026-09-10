-- lead_time is free text, not a number.
--
-- The Sheets column held whatever the supplier typed -- "3-4 weeks", "21 days",
-- "ex-stock" -- and only the reorder calculation stripped the digits out of it.
-- Typing it as an integer silently threw that away: a deck printed a bare
-- "Lead time 21" with no unit, and "3-4 weeks" could not be entered at all.
ALTER TABLE "products" ALTER COLUMN "lead_time" TYPE TEXT USING "lead_time"::text;
