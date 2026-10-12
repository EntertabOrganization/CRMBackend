import 'reflect-metadata';
import { Controller, Delete, Get, Patch, Post, Put, Req, Res, type Type } from '@nestjs/common';
import { NextRequest } from 'next/server';
import type { PackRouter } from './http';

type Incoming = { method: string; originalUrl: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Outgoing = { status(code: number): Outgoing; setHeader(name: string, value: string): void; send(body: string): void };
const methods = { GET: Get, POST: Post, PUT: Put, PATCH: Patch, DELETE: Delete };

/** Each operation has a real Nest route/controller, sharing authorization and transaction semantics with Next. */
export function nestControllers(router: PackRouter): Type[] {
  const groups = new Map<string, typeof router.entries>();
  for (const entry of router.entries) groups.set(entry.controller, [...(groups.get(entry.controller) ?? []), entry]);
  return [...groups].map(([name, entries]) => {
    class DomainController {}
    Object.defineProperty(DomainController, 'name', { value: name });
    Controller()(DomainController);
    for (const [index, entry] of entries.entries()) {
      const methodName = 'operation' + index;
      Object.defineProperty(DomainController.prototype, methodName, { configurable: true,
        value: async (req: Incoming, res: Outgoing) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(', '));
          }
          // Internal fixed origin avoids trusting Host/forwarded headers in access decisions.
          const request = new NextRequest(new URL(req.originalUrl, 'http://process-platform.internal'), {
            method: req.method, headers,
            ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: JSON.stringify(req.body ?? {}) } : {}),
          });
          const response = await router.dispatch(request);
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.status(response.status).send(await response.text());
        } });
      const descriptor = Object.getOwnPropertyDescriptor(DomainController.prototype, methodName)!;
      const decorate = methods[entry.method as keyof typeof methods];
      decorate(entry.path.slice(1))(DomainController.prototype, methodName, descriptor);
      Req()(DomainController.prototype, methodName, 0);
      Res()(DomainController.prototype, methodName, 1);
    }
    return DomainController;
  });
}
