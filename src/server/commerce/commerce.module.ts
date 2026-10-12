import { Module } from '@nestjs/common';
import { nestControllers } from '../process-platform/nest-adapter';
import { commerceRouter } from './routes';
export class CommerceModule {}
Module({ controllers: nestControllers(commerceRouter) })(CommerceModule);
