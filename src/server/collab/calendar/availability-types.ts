export type Interval = { startAt: Date; endAt: Date };
export type WorkingWindow = { dayOfWeek: number; localStartTime: string; localEndTime: string };
export type WorkingDateOverride = { date: string; windows: Array<Omit<WorkingWindow, 'dayOfWeek'>> };
export type WorkingSchedule = {
  id: string; workspaceId: string; timezone: string; weekly: WorkingWindow[];
  holidays: string[]; overrides: WorkingDateOverride[];
  version: number; createdAt: Date; updatedAt: Date;
};
export type UserWorkingSchedule = WorkingSchedule & { userId: string };
/** Rebuildable, version-fenced recurrence coverage; never a reservation or an authorization grant. */
export type CalendarAvailabilityRebuild = {
  id: string; workspaceId: string; eventId: string; recurrenceRuleId: string;
  eventVersion: number; ruleVersion: number; startAt: Date; endAt: Date;
  status: 'PENDING' | 'READY' | 'FAILED' | 'CANCELLED';
  cursorRecurrenceId: string | null; cursorOrdinal: number;
  busy: Array<{ startAt: string; endAt: string }>;
  failures: number; nextAttemptAt: Date | null; lastErrorCode: string | null;
  expiresAt: Date; version: number; createdAt: Date; updatedAt: Date;
};

/** Half-open intervals; merging removes booking count and identity from availability responses. */
export function mergeIntervals(input: Interval[]): Interval[] {
  const sorted = input.filter((row) => row.endAt > row.startAt).map((row) => ({ ...row }))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime());
  const result: Interval[] = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (last && interval.startAt <= last.endAt) { if (interval.endAt > last.endAt) last.endAt = interval.endAt; }
    else result.push(interval);
  }
  return result;
}
export function intersectIntervals(left: Interval[], right: Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    const startAt = new Date(Math.max(left[i].startAt.getTime(), right[j].startAt.getTime()));
    const endAt = new Date(Math.min(left[i].endAt.getTime(), right[j].endAt.getTime()));
    if (endAt > startAt) result.push({ startAt, endAt });
    if (left[i].endAt <= right[j].endAt) i += 1; else j += 1;
  }
  return mergeIntervals(result);
}
export function subtractIntervals(available: Interval[], busy: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const window of available) {
    let cursor = window.startAt;
    for (const blocked of busy) {
      if (blocked.endAt <= cursor) continue;
      if (blocked.startAt >= window.endAt) break;
      if (blocked.startAt > cursor) result.push({ startAt: cursor, endAt: blocked.startAt });
      if (blocked.endAt > cursor) cursor = blocked.endAt;
      if (cursor >= window.endAt) break;
    }
    if (cursor < window.endAt) result.push({ startAt: cursor, endAt: window.endAt });
  }
  return result;
}
