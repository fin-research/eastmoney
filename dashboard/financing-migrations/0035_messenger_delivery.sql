SET search_path TO financing, public;
ALTER TABLE reminder_deliveries DROP CONSTRAINT IF EXISTS reminder_deliveries_status_check;
ALTER TABLE reminder_deliveries ADD CONSTRAINT reminder_deliveries_status_check CHECK (status IN ('pending', 'queued', 'sent', 'failed'));
