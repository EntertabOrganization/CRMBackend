import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';

it('publishes complete immutable objects under simultaneous retries and rejects replacement or traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crm-object-test-'));
  try {
    const objects = new LocalObjectStorage(root), key = `${randomUUID()}/objects/${randomUUID()}/content`;
    const bytes = Buffer.alloc(1024 * 1024, 97);
    await Promise.all([objects.putImmutable(key, bytes), objects.putImmutable(key, bytes)]);
    expect(await objects.read(key)).toEqual(bytes);
    await expect(objects.putImmutable(key, Buffer.from('replacement'))).rejects.toMatchObject({ code: 'UPLOAD_CHECKSUM_MISMATCH' });
    expect(await objects.read(key)).toEqual(bytes);
    expect(await readdir(path.dirname(path.join(root, ...key.split('/'))))).toEqual(['content']);
    await expect(objects.read(`${randomUUID()}/objects/../outside`)).rejects.toMatchObject({ code: 'FILE_OBJECT_INVALID' });
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('crm-object-test-')) throw new Error('Unexpected test directory');
    await rm(root, { recursive: true, force: true });
  }
});
