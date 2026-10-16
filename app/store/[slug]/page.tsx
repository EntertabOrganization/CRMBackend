import { Storefront } from '@/src/client/suite/storefront';
export const metadata = { title: 'Store · TrueCRM' };
export default async function Page({ params }: { params: Promise<{ slug: string }> }) { return <Storefront slug={(await params).slug} />; }
