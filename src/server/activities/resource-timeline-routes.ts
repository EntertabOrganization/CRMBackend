import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { ResourceTimelineService } from './resource-timeline-service';

export const resourceTimeline = new ResourceTimelineService(prisma);
export const resourceTimelineRouter = new PackRouter()
  .add('GET','/api/v1/crm/WORKFLOW_EXECUTION/:executionId/timeline','SharedTimelineController',c => resourceTimeline.read(c.actor,c.params.executionId,c.query))
  .add('POST','/api/v1/crm/WORKFLOW_EXECUTION/:executionId/timeline/comments','SharedTimelineController',c => resourceTimeline.create(c.actor,c.params.executionId,c.body,c.request.headers.get('idempotency-key')),201)
  .add('GET','/api/v1/crm/timeline/comments/:commentId','SharedTimelineController',c => resourceTimeline.comment(c.actor,c.params.commentId,'READ'))
  .add('PATCH','/api/v1/crm/timeline/comments/:commentId','SharedTimelineController',c => resourceTimeline.comment(c.actor,c.params.commentId,'EDIT',c.body))
  .add('DELETE','/api/v1/crm/timeline/comments/:commentId','SharedTimelineController',c => resourceTimeline.comment(c.actor,c.params.commentId,'DELETE',c.body));
