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
// Knowledge Base: search source + access resolver, AI indexer consumer, review/import/export/reindex jobs.
import '../knowledge/index-service';
import '../knowledge/article-service';
import '../knowledge/exchange-service';
// AI CoPilot: run/tool/purge/evaluation/transcription/image jobs and the Billing usage completion check.
import '../ai/run-service';
import '../ai/conversation-service';
import '../ai/governance-service';
import '../ai/domain-service';
