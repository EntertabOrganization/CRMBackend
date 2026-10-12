import { Module } from '@nestjs/common';
import { nestControllers } from '../process-platform/nest-adapter';
import { inventoryRouter } from './routes';
export class InventoryModule {}
Module({ controllers: nestControllers(inventoryRouter) })(InventoryModule);
