-- Set when the "your wash time starts soon" push for a booking has been claimed by the reminder cron,
-- so each booking is reminded at most once (see src/reminder.ts).
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;
