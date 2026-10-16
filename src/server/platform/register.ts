/** Side-effect registrations shared by API routes and workers (consumers, jobs, schedules, search sources, privacy hooks). */
import './search-service';
import './search-sources';
import './privacy-service';
import './privacy-hooks';
import './ops-service';
// Subscription Billing jobs/schedules/invoice effects (composition root for workers).
import '../billing/usage-service';
import '../billing/subscription-service';
import '../billing/finance-service';
// Partner Program: Billing discount/relation resolvers, commission consumer, maintenance/export jobs.
import '../partners/commercial-service';
import '../partners/finance-service';
import '../partners/governance-service';
