import { AppError } from '../errors';
import { hydrateState } from '../persistence';
import { InMemoryStore } from '../store';
import { AccessService } from '../access-service';
import { RealtimeHub } from '../realtime';
import { CollabSupport } from '../collab/support';
import { WorkingScheduleService } from '../collab/calendar/working-schedule-service';
import { requirePermission, type Principal, type Tx } from '../process-platform/context';

/** Calendar owns working-day/DST resolution; workflow only consumes its windows. */
export async function workflowBusinessTime(tx: Tx, actor: Principal) {
  requirePermission(actor,'calendar.free_busy');
  const store = new InMemoryStore(await hydrateState(tx)), access = new AccessService(store);
  const schedules = new WorkingScheduleService(new CollabSupport({ store,access,realtime: new RealtimeHub() }));
  const windows = (startAt: Date,endAt: Date) => schedules.windows(actor.workspaceId,null,{ startAt,endAt }).intervals;
  return {
    remaining: (start: Date,end: Date) => Math.max(0,Math.ceil(windows(start,end).reduce((total,w) => total+w.endAt.getTime()-w.startAt.getTime(),0)/1000)),
    due: (start: Date,seconds: number,deadline: Date) => {
      let remaining = seconds*1000, cursor = start;
      for (let month = 0; month < 13 && cursor < deadline; month++) {
        const end = new Date(Math.min(deadline.getTime(),cursor.getTime()+30*86400000));
        for (const window of windows(cursor,end)) {
          const duration = window.endAt.getTime()-window.startAt.getTime();
          if (duration >= remaining) return new Date(window.startAt.getTime()+remaining);
          remaining -= duration;
        }
        cursor = end;
      }
      throw new AppError('WORKFLOW_RUNTIME_LIMIT_EXCEEDED','Working time exceeds the execution lifetime.',422);
    },
  };
}
