-- Pending reservations are availability sources too. Advance the locked Workspace revision after
-- validating/acquiring a hold so an Event writer using an earlier graph must retry after waiting.
CREATE TRIGGER calendar_booking_hold_epoch AFTER INSERT OR UPDATE OR DELETE ON calendar_bookings
  FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
