import { KnowledgeEditor } from '@/src/client/suite/knowledge-editor';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { return <KnowledgeEditor articleId={(await params).id} />; }
