-- Bounded oldest-first pruning avoids unindexed high-volume log scans.
CREATE INDEX automation_logs_workspace_id_created_at_id_idx
  ON automation_logs(workspace_id, created_at, id);
