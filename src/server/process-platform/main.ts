import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configurePackBodyParsing } from './nest-adapter';
import { nestControllers } from './nest-adapter';
import { resourceTimelineRouter } from '../activities/resource-timeline-routes';
import { SpaModule } from '../spa/spa.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CommerceModule } from '../commerce/commerce.module';
import { MarketingModule } from '../marketing/routes';
import { HrModule } from '../hr/routes';
import { SitesModule } from '../sites/routes';
import { prisma } from '../prisma-client';

export class ProcessPlatformModule {}
Module({ imports: [SpaModule, WorkflowsModule,InventoryModule,CommerceModule,MarketingModule,HrModule,SitesModule],controllers: nestControllers(resourceTimelineRouter) })(ProcessPlatformModule);

export async function startProcessPlatform(port = Number(process.env.PROCESS_PLATFORM_PORT ?? 3002)) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid process platform port');
  const app = await NestFactory.create<NestExpressApplication>(ProcessPlatformModule, { bodyParser: true,rawBody: true });
  configurePackBodyParsing(app);
  app.enableShutdownHooks();
  await app.listen(port, process.env.PROCESS_PLATFORM_HOST ?? '127.0.0.1');
  return app;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/process-platform/main.ts')) {
  startProcessPlatform().catch(async () => {
    // Do not expose connection strings or provider credentials in startup errors.
    process.stderr.write('Process platform startup failed. Check database and server configuration.\n');
    await prisma.$disconnect();
    process.exitCode = 1;
  });
}
