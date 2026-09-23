-- Abuse brake for resident-to-holder push messages. Only the number of messages one
-- apartment has sent about another apartment's reservation is kept, never the text.
-- Rows for past days are deleted by the daily cron.
CREATE TABLE message_counts (
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  start_min  INTEGER NOT NULL,
  holder     TEXT NOT NULL,   -- apartment holding the reservation
  sender     TEXT NOT NULL,   -- apartment sending the messages
  sent       INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, date, start_min, holder, sender)
);
