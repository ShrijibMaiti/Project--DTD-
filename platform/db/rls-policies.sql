-- Tenant isolation enforced by the DATABASE, not by developer discipline.
-- Every tenant-scoped query runs inside DatabaseService.withTenant(), which
-- sets app.transporter_id for the transaction. A missing setting = zero rows.
-- System jobs set app.role = 'system' and bypass tenancy deliberately.

CREATE OR REPLACE FUNCTION current_transporter() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.transporter_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_system() RETURNS boolean AS $$
  SELECT current_setting('app.role', true) = 'system'
$$ LANGUAGE sql STABLE;

-- Enable + force RLS (force applies even to the table owner).
ALTER TABLE trucks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucks              FORCE  ROW LEVEL SECURITY;
ALTER TABLE drivers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers             FORCE  ROW LEVEL SECURITY;
ALTER TABLE price_quotes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_quotes        FORCE  ROW LEVEL SECURITY;
ALTER TABLE bookings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings            FORCE  ROW LEVEL SECURITY;
ALTER TABLE kyc_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_records         FORCE  ROW LEVEL SECURITY;
ALTER TABLE insurance_policies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_policies  FORCE  ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            FORCE  ROW LEVEL SECURITY;
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents           FORCE  ROW LEVEL SECURITY;
ALTER TABLE claims_packets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims_packets      FORCE  ROW LEVEL SECURITY;
ALTER TABLE support_tickets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets     FORCE  ROW LEVEL SECURITY;

-- One policy pattern for all tenant tables.
CREATE POLICY tenant_isolation ON trucks
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON drivers
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON price_quotes
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON bookings
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON kyc_records
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON insurance_policies
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON payments
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON documents
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON claims_packets
  USING (is_system() OR transporter_id = current_transporter());
CREATE POLICY tenant_isolation ON support_tickets
  USING (is_system() OR transporter_id = current_transporter());

-- Child tables inherit isolation through their parent FK.
ALTER TABLE booking_stops    ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_stops    FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON booking_stops
  USING (
    is_system() OR EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.id = booking_stops.booking_id
        AND b.transporter_id = current_transporter()
    )
  );

ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_messages
  USING (
    is_system() OR EXISTS (
      SELECT 1 FROM support_tickets t
      WHERE t.id = support_messages.ticket_id
        AND t.transporter_id = current_transporter()
    )
  );