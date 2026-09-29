import { NextRequest } from 'next/server'; import { appContext } from '@/src/server/app-context'; import { route } from '@/src/server/response';
import { rateLimitRequest } from '@/src/server/rate-limit';
export async function POST(request:NextRequest,{params}:{params:Promise<{connectionId:string}>}){return route(async()=>{rateLimitRequest(request,{scope:'channel.webhook',limit:300,windowMs:60000});return appContext.commercialPack.contactCenter.inbound((await params).connectionId,Object.fromEntries(request.headers.entries()),await request.text());});}
