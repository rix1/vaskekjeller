-- Keep existing reservations safe if an administrator changes the slot length.
CREATE TRIGGER bookings_no_overlap
BEFORE INSERT ON bookings
WHEN NEW.cancelled_at IS NULL AND EXISTS (
  SELECT 1 FROM bookings
  WHERE machine_id = NEW.machine_id AND date = NEW.date
    AND cancelled_at IS NULL
    AND start_min < NEW.end_min AND end_min > NEW.start_min
)
BEGIN
  SELECT RAISE(ABORT, 'booking_overlap');
END;
