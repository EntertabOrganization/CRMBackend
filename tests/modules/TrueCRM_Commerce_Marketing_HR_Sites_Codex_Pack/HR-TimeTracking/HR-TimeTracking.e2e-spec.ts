import { repositoryHarness } from '../_harness/adapter';
const h=repositoryHarness();
describe('HR HTTP + history/leave-ledger E2E contract',()=>{
  it('clock-in idempotency never creates a second active session',async()=>{
    const f=await h.seed('hr_attendance');const req={actor:'employee' as const,method:'POST' as const,path:'/api/v1/hr/me/clock-in',headers:{'Idempotency-Key':'clock-in-001'},body:{source:'WEB'}};
    const a=await h.request(f,req),b=await h.request(f,req);expect([200,201]).toContain(a.status);expect(b.body.data?.id).toBe(a.body.data?.id);
    const events=await h.observe(f,'hr_work_events',{idempotencyKey:'clock-in-001'});expect(events).toHaveLength(1);
  });
  it('a correction remains reviewed and original work events remain available',async()=>{
    const f=await h.seed('hr_attendance');const old=await h.observe(f,'hr_work_events',{sessionId:f.ids.workSessionId});
    const r=await h.request(f,{actor:'employee',method:'POST',path:'/api/v1/hr/attendance/corrections',body:{employeeId:f.ids.employeeId,workSessionId:f.ids.workSessionId,reason:'Forgot clock out',proposedEvents:[{type:'CLOCK_OUT',occurredAt:f.ids.correctedClockOutAt}]}});
    expect([200,201,202]).toContain(r.status);const newer=await h.observe(f,'hr_work_events',{sessionId:f.ids.workSessionId});expect(newer.length).toBeGreaterThanOrEqual(old.length);
    expect(r.body.data?.status).toBe('REQUESTED');
  });
  it('cannot edit a locked timesheet without approved reopen',async()=>{
    const f=await h.seed('hr_attendance');const r=await h.request(f,{actor:'employee',method:'PATCH',path:`/api/v1/hr/timesheets/${f.ids.lockedTimesheetId}`,body:{workedMinutes:9999}});expect([403,405,409]).toContain(r.status);
  });
  it('prevents two paid leave holds spending same remaining balance',async()=>{
    const f=await h.seed('hr_attendance');const make=(key:string)=>h.request(f,{actor:'employee',method:'POST',path:'/api/v1/hr/leave/requests',headers:{'Idempotency-Key':key},body:{leaveTypeId:f.ids.leaveTypeId,fromLocal:f.ids.leaveDateA,toLocal:f.ids.leaveDateA}});
    const [a,b]=await Promise.all([make('leave-request-a'),make('leave-request-b')]);expect([200,201,202,409]).toContain(a.status);expect([200,201,202,409]).toContain(b.status);
    const holds=await h.observe(f,'hr_leave_ledger',{employeeId:f.ids.employeeId,kind:'REQUEST_HOLD',active:true});expect(holds.reduce((n:number,r:any)=>n+Number(r.units),0)).toBeLessThanOrEqual(1);
  });
  it('denies private HR data from ordinary manager or foreign workspace',async()=>{
    const f=await h.seed('hr_attendance');const r=await h.request(f,{actor:'manager',method:'GET',path:`/api/v1/hr/employees/${f.ids.foreignEmployeeId}`});expect([403,404]).toContain(r.status);
  });
});
