import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { readJson } from '@/src/server/request';
import { route, routeWithMeta } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';
import { paginateCommercial } from '@/src/server/commercial/pagination';
export async function GET(request:NextRequest){return routeWithMeta(async()=>{const {actor}=await requireWorkspaceContext(request);return paginateCommercial(request,appContext.commercialPack.requisites.listPresets(actor),{searchable:['name','countryCode','entityTypeCode'],filterable:['countryCode','entityTypeCode','active'],sortable:['name','countryCode','id'],defaultSortBy:'id'});});}
export async function POST(request:NextRequest){return route(async()=>{const {actor}=await requireWorkspaceContext(request);return appContext.commercialPack.requisites.createPreset(actor,await readJson(request));});}
