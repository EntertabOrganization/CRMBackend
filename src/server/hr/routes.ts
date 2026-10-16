import { Module } from '@nestjs/common';
import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { nestControllers } from '../process-platform/nest-adapter';
import { HrPeopleService } from './people-service';
import { HrScheduleService } from './schedule-service';
import { HrWorktimeService } from './worktime-service';
import { HrTimesheetService } from './timesheet-service';
import { HrLeaveService } from './leave-service';
import { HrInsightService } from './insight-service';

export const hrPeople = new HrPeopleService(prisma);
export const hrSchedules = new HrScheduleService(prisma);
export const hrWorktime = new HrWorktimeService(prisma);
export const hrTimesheets = new HrTimesheetService(prisma);
export const hrLeave = new HrLeaveService(prisma);
export const hrInsights = new HrInsightService(prisma);
const idem = (h: Headers) => h.get('idempotency-key');
const ip = (h: Headers) => h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
const H = '/api/v1/hr';

export const hrRouter = new PackRouter()
  .add('POST', H + '/employees', 'HrEmployeesController', c => hrPeople.create(c.actor, c.body), 201)
  .add('GET', H + '/employees', 'HrEmployeesController', c => hrPeople.list(c.actor, c.query))
  .add('GET', H + '/employees/:id', 'HrEmployeesController', c => hrPeople.get(c.actor, c.params.id))
  .add('PATCH', H + '/employees/:id', 'HrEmployeesController', c => hrPeople.patch(c.actor, c.params.id, c.body))
  .add('POST', H + '/employees/:id/activate', 'HrEmployeesController', c => hrPeople.activate(c.actor, c.params.id, c.body))
  .add('POST', H + '/employees/:id/terminate', 'HrEmployeesController', c => hrPeople.terminate(c.actor, c.params.id, c.body))
  .add('GET', H + '/positions', 'HrEmployeesController', c => hrPeople.positions(c.actor))
  .add('POST', H + '/positions', 'HrEmployeesController', c => hrPeople.positions(c.actor, c.body), 201)
  .add('POST', H + '/employees/:id/onboard', 'HrLifecycleController', c => hrPeople.onboard(c.actor, c.params.id, c.body), 201)
  .add('POST', H + '/employees/:id/offboard', 'HrLifecycleController', c => hrPeople.offboard(c.actor, c.params.id, c.body), 201)
  .add('GET', H + '/lifecycle/:id', 'HrLifecycleController', c => hrPeople.lifecycle(c.actor, c.params.id))
  .add('POST', H + '/employees/:id/documents/bind', 'HrLifecycleController', c => hrPeople.bindDocument(c.actor, c.params.id, c.body), 201)
  .add('GET', H + '/employees/:id/documents', 'HrLifecycleController', c => hrPeople.documents(c.actor, c.params.id))
  .add('DELETE', H + '/employees/:id/documents/:bindingId', 'HrLifecycleController', c => hrPeople.removeDocument(c.actor, c.params.id, c.params.bindingId))
  .add('POST', H + '/work-locations', 'HrSchedulesController', c => hrSchedules.location(c.actor, c.body), 201)
  .add('POST', H + '/schedules', 'HrSchedulesController', c => hrSchedules.create(c.actor, c.body), 201)
  .add('GET', H + '/schedules', 'HrSchedulesController', c => hrSchedules.list(c.actor))
  .add('POST', H + '/schedules/:id/versions', 'HrSchedulesController', c => hrSchedules.addVersion(c.actor, c.params.id, c.body), 201)
  .add('POST', H + '/employees/:id/schedule-assignments', 'HrSchedulesController', c => hrSchedules.assign(c.actor, c.params.id, c.body), 201)
  .add('POST', H + '/shifts', 'HrSchedulesController', c => hrSchedules.createShift(c.actor, c.body), 201)
  .add('POST', H + '/shifts/:id/assign', 'HrSchedulesController', c => hrSchedules.assignShift(c.actor, c.params.id, c.body), 201)
  .add('GET', H + '/employees/:id/expected-workdays', 'HrSchedulesController', c => hrSchedules.expectedWorkdays(c.actor, c.params.id, c.query))
  .add('POST', H + '/me/clock-in', 'HrWorktimeController', c => hrWorktime.clock(c.actor, 'CLOCK_IN', c.body, idem(c.request.headers), ip(c.request.headers)), 201)
  .add('POST', H + '/me/clock-out', 'HrWorktimeController', c => hrWorktime.clock(c.actor, 'CLOCK_OUT', c.body, idem(c.request.headers), ip(c.request.headers)))
  .add('POST', H + '/me/break/start', 'HrWorktimeController', c => hrWorktime.clock(c.actor, 'BREAK_START', c.body, idem(c.request.headers), ip(c.request.headers)))
  .add('POST', H + '/me/break/end', 'HrWorktimeController', c => hrWorktime.clock(c.actor, 'BREAK_END', c.body, idem(c.request.headers), ip(c.request.headers)))
  .add('GET', H + '/me/work-sessions', 'HrWorktimeController', c => hrWorktime.sessions(c.actor, null, c.query))
  .add('GET', H + '/employees/:id/work-sessions', 'HrWorktimeController', c => hrWorktime.sessions(c.actor, c.params.id, c.query))
  .add('POST', H + '/clock-events/import', 'HrWorktimeController', c => hrWorktime.importEvents(c.actor, c.body), 201)
  .add('GET', H + '/employees/:id/attendance', 'HrAttendanceController', c => hrWorktime.attendance(c.actor, c.params.id, c.query))
  .add('GET', H + '/attendance/anomalies', 'HrAttendanceController', c => hrWorktime.anomalies(c.actor, c.query))
  .add('GET', H + '/attendance/corrections', 'HrAttendanceController', c => hrWorktime.corrections(c.actor, c.query))
  .add('POST', H + '/attendance/corrections', 'HrAttendanceController', c => hrWorktime.requestCorrection(c.actor, c.body), 201)
  .add('POST', H + '/attendance/corrections/:id/approve', 'HrAttendanceController', c => hrWorktime.decide(c.actor, c.params.id, c.body, 'APPROVE'))
  .add('POST', H + '/attendance/corrections/:id/reject', 'HrAttendanceController', c => hrWorktime.decide(c.actor, c.params.id, c.body, 'REJECT'))
  .add('POST', H + '/attendance/corrections/:id/override', 'HrAttendanceController', c => hrWorktime.decide(c.actor, c.params.id, c.body, 'OVERRIDE'))
  .add('GET', H + '/timesheets', 'HrTimesheetsController', c => hrTimesheets.list(c.actor, c.query))
  .add('POST', H + '/timesheets/compile', 'HrTimesheetsController', c => hrTimesheets.compile(c.actor, c.body), 201)
  .add('GET', H + '/timesheets/:id', 'HrTimesheetsController', c => hrTimesheets.get(c.actor, c.params.id))
  .add('PATCH', H + '/timesheets/:id', 'HrTimesheetsController', c => hrTimesheets.patch(c.actor, c.params.id))
  .add('POST', H + '/timesheets/:id/submit', 'HrTimesheetsController', c => hrTimesheets.submit(c.actor, c.params.id, c.body))
  .add('POST', H + '/timesheets/:id/approve', 'HrTimesheetsController', c => hrTimesheets.review(c.actor, c.params.id, c.body, 'APPROVED'))
  .add('POST', H + '/timesheets/:id/reject', 'HrTimesheetsController', c => hrTimesheets.review(c.actor, c.params.id, c.body, 'REJECTED'))
  .add('POST', H + '/timesheets/:id/lock', 'HrTimesheetsController', c => hrTimesheets.review(c.actor, c.params.id, c.body, 'LOCKED'))
  .add('POST', H + '/timesheets/:id/reopen', 'HrTimesheetsController', c => hrTimesheets.review(c.actor, c.params.id, c.body, 'REOPENED'))
  .add('POST', H + '/overtime/policies', 'HrOvertimeController', c => hrTimesheets.policy(c.actor, c.body), 201)
  .add('GET', H + '/overtime', 'HrOvertimeController', c => hrTimesheets.overtime(c.actor, c.query))
  .add('POST', H + '/overtime/recalculate', 'HrOvertimeController', c => hrTimesheets.recalculate(c.actor, c.body))
  .add('POST', H + '/overtime/:id/request', 'HrOvertimeController', c => hrTimesheets.overtimeDecision(c.actor, c.params.id, c.body, 'REQUESTED'))
  .add('POST', H + '/overtime/:id/approve', 'HrOvertimeController', c => hrTimesheets.overtimeDecision(c.actor, c.params.id, c.body, 'APPROVED'))
  .add('POST', H + '/overtime/:id/reject', 'HrOvertimeController', c => hrTimesheets.overtimeDecision(c.actor, c.params.id, c.body, 'REJECTED'))
  .add('GET', H + '/reports/overtime', 'HrReportsController', c => hrInsights.reportData(c.actor, 'overtime', c.query))
  .add('POST', H + '/leave/types', 'HrLeaveController', c => hrLeave.createType(c.actor, c.body), 201)
  .add('POST', H + '/leave/policies', 'HrLeaveController', c => hrLeave.createPolicy(c.actor, c.body), 201)
  .add('GET', H + '/me/leave-balances', 'HrLeaveController', c => hrLeave.balances(c.actor, null))
  .add('GET', H + '/employees/:id/leave-balances', 'HrLeaveController', c => hrLeave.balances(c.actor, c.params.id))
  .add('POST', H + '/leave/balances/adjust', 'HrLeaveController', c => hrLeave.adjust(c.actor, c.body, idem(c.request.headers)), 201)
  .add('POST', H + '/leave/balances/recalculate', 'HrLeaveController', c => hrLeave.recalculate(c.actor, c.body))
  .add('POST', H + '/leave/requests', 'HrLeaveController', c => hrLeave.createRequest(c.actor, c.body, idem(c.request.headers)), 201)
  .add('GET', H + '/me/leave-requests', 'HrLeaveController', c => hrLeave.mine(c.actor))
  .add('POST', H + '/leave/requests/:id/submit', 'HrLeaveController', c => hrLeave.submit(c.actor, c.params.id, c.body))
  .add('POST', H + '/leave/requests/:id/approve', 'HrLeaveController', c => hrLeave.decide(c.actor, c.params.id, c.body, 'APPROVE'))
  .add('POST', H + '/leave/requests/:id/reject', 'HrLeaveController', c => hrLeave.decide(c.actor, c.params.id, c.body, 'REJECT'))
  .add('POST', H + '/leave/requests/:id/cancel', 'HrLeaveController', c => hrLeave.cancel(c.actor, c.params.id, c.body))
  .add('GET', H + '/leave/requests/:id/reason', 'HrLeaveController', c => hrLeave.reason(c.actor, c.params.id))
  .add('GET', H + '/absences/calendar', 'HrLeaveController', c => hrLeave.calendar(c.actor, c.query))
  .add('POST', H + '/work-reports', 'HrWorkReportsController', c => hrInsights.createReport(c.actor, c.body), 201)
  .add('GET', H + '/work-reports', 'HrWorkReportsController', c => hrInsights.list(c.actor, c.query))
  .add('PATCH', H + '/work-reports/:id', 'HrWorkReportsController', c => hrInsights.patch(c.actor, c.params.id, c.body))
  .add('POST', H + '/work-reports/:id/submit', 'HrWorkReportsController', c => hrInsights.transition(c.actor, c.params.id, c.body, 'SUBMITTED'))
  .add('POST', H + '/work-reports/:id/review', 'HrWorkReportsController', c => hrInsights.transition(c.actor, c.params.id, c.body, 'REVIEWED'))
  .add('POST', H + '/work-reports/:id/return', 'HrWorkReportsController', c => hrInsights.transition(c.actor, c.params.id, c.body, 'RETURNED'))
  .add('GET', H + '/reports/attendance', 'HrReportsController', c => hrInsights.reportData(c.actor, 'attendance', c.query))
  .add('GET', H + '/reports/leave', 'HrReportsController', c => hrInsights.reportData(c.actor, 'leave', c.query))
  .add('GET', H + '/reports/headcount', 'HrReportsController', c => hrInsights.reportData(c.actor, 'headcount', c.query))
  .add('POST', H + '/reports/export', 'HrReportsController', c => hrInsights.exportReport(c.actor, c.body))
  .add('GET', H + '/privacy/retention-status', 'HrReportsController', c => hrInsights.retentionStatus(c.actor))
  .add('POST', H + '/privacy/retention-policies', 'HrReportsController', c => hrInsights.retentionPolicy(c.actor, c.body), 201)
  .add('POST', H + '/privacy/legal-holds', 'HrReportsController', c => hrInsights.legalHold(c.actor, c.body), 201)
  .add('POST', H + '/privacy/retention/apply', 'HrReportsController', c => hrInsights.applyRetention(c.actor, c.body));

export class HrModule {}
Module({ controllers: nestControllers(hrRouter) })(HrModule);
