# Resource reservations

One canonical reservation links each Event to a resource. A non-recurring Event
uses `SINGLE`; a recurring parent uses `__SERIES__` and owns occurrence rows keyed
by original recurrence identity. Moving an occurrence updates its interval while
preserving its reservation ID. Cancellation retains evidence; removing a rule
returns the parent link to `SINGLE` and cancels its occurrence rows.

Acquisition and recurrence edits preflight working hours, capacity, self-overlap
and other authoritative Event series. The initial projection covers 93 days;
resource availability reads extend it into the requested window. Edits rebuild
previously materialized windows, including moved exceptions and future ranges.
Resource reservations apply even when an Event's personal busy status is FREE.
Availability exposes only merged intervals, without Event metadata.

Unbounded recurrence has no finite complete projection. Finalization therefore
scans the current rule, exceptions and ranges rather than trusting the stored
horizon. A query has a shared 5,000-candidate limit and a 1,000-root limit; a
reservation projection also has a 5,000-candidate limit. Exceeding a limit returns
`AVAILABILITY_UNAVAILABLE` without publishing partial availability or reservations.

Workspace revision fencing serializes commits against resource, Event, recurrence,
membership and schedule changes. PostgreSQL composite foreign keys scope parent
and occurrence links; a deferred exclusive interval constraint validates the
final materialized graph. Persistence writes parent links before occurrences,
independently of hydration order. Resource/Event cancellation releases all
occurrences in the same transaction. Public resource routes retain live resource
and Event authorization; internal Booking integration must use its own trusted
domain port.
