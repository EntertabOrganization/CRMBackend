-- Resource acquisitions use the same locked revision as schedules and Calendar source writes.
CREATE TRIGGER calendar_booking_source_epoch BEFORE INSERT OR UPDATE OR DELETE ON calendar_resources
  FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
CREATE TRIGGER calendar_booking_source_epoch BEFORE INSERT OR UPDATE OR DELETE ON calendar_resource_bookings
  FOR EACH ROW EXECUTE FUNCTION calendar_booking_source_epoch();
