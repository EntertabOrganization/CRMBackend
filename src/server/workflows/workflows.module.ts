import { Module } from '@nestjs/common';
import { nestControllers } from '../process-platform/nest-adapter';
import { workflowRouter } from './routes';

export class WorkflowsModule {}
Module({ controllers: nestControllers(workflowRouter) })(WorkflowsModule);
