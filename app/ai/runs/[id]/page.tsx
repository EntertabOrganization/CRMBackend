import { AiStream } from '@/src/client/suite/ai-stream';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { return <AiStream runId={(await params).id} />; }
