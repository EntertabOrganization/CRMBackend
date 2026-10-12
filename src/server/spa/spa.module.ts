import { Module } from '@nestjs/common';
import { nestControllers } from '../process-platform/nest-adapter';
import { spaRouter } from './routes';

export class SpaModule {}
Module({ controllers: nestControllers(spaRouter) })(SpaModule);
