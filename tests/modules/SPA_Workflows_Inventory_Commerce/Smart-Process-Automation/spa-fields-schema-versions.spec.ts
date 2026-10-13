import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from '@/tests/support/process-platform-db';
import { spaFixture } from '@/tests/support/spa-fixture';
import { fieldDefinition, fieldTypes, parseFieldValue } from '@/src/server/spa/field-metadata';
import { SpaMigrationService } from '@/src/server/spa/migration-service';

jest.setTimeout(120000);
let db: PrismaClient;
beforeAll(async () => {
  const url = await prepareProcessPlatformDatabase('truecrm_spa_schema_test');
  db = new PrismaClient({ datasources: { db: { url } } });
}, 300000);
afterAll(async () => { await db?.$disconnect(); });

describe('SPA Fields, Schema Drafts and Publication — unit/integration contract', () => {
  it('field metadata validates every supported typed value and multi-value option membership', () => {
    const id = randomUUID(), option = { id, code: 'ONE', label: 'One', isActive: true, sortOrder: 0 };
    const values: Record<string, unknown> = { TEXT: 'text', TEXTAREA: 'paragraph', INTEGER: 42, DECIMAL: '1.25',
      BOOLEAN: false, DATE: '2030-01-01', DATETIME: '2030-01-01T00:00:00Z', LIST: id, MULTI_LIST: [id],
      EMAIL: 'user@example.test', PHONE: '+201000000000', URL: 'https://example.test/', MONEY: { amount: '1.25', currency: 'USD' },
      USER: id, CRM_REF: { entityType: 'CONTACT', entityId: id }, FILE: id, SPA_REF: id };
    const context = { registeredEntityTypes: ['CONTACT', 'SPA_ITEM'], checkUser: () => 'OK' as const,
      isUserSelectable: () => true, checkCrmReference: (_type: string, ref: string) => ref === id ? 'OK' as const : 'MISSING' as const,
      checkFile: () => 'OK' as const };
    for (const fieldType of fieldTypes) {
      const field = fieldDefinition.parse({ id: randomUUID(), code: 'VALUE', name: 'Value', fieldType,
        options: ['LIST', 'MULTI_LIST'].includes(fieldType) ? [option] : [], ...(fieldType === 'SPA_REF' ? { referenceTypeId: randomUUID() } : {}) });
      expect(parseFieldValue(field, values[fieldType], randomUUID(), context)).not.toBeNull();
    }
    const multiple = fieldDefinition.parse({ id: randomUUID(), code: 'VALUES', name: 'Choices', fieldType: 'MULTI_LIST', options: [option] });
    expect(parseFieldValue(multiple, [id], randomUUID(), context)).toEqual([id]);
    expect(() => parseFieldValue(multiple, [randomUUID()], randomUUID(), context)).toThrow();
    expect(() => parseFieldValue(multiple, [id, id], randomUUID(), context)).toThrow();
  });
  it('system field name rejected and duplicate codes rejected', async () => {
    const f = await spaFixture(db), draft = await f.schemas.draft(f.actor, f.type.id);
    for (const code of ['ID', 'WORKSPACE_ID', 'VALUE']) await expect(f.schemas.addField(f.actor, f.type.id,
      { code, name: 'Invalid', fieldType: 'TEXT' })).rejects.toMatchObject({ code: 'SPA_FIELD_CODE_EXISTS' });
    expect((await f.schemas.draft(f.actor, f.type.id)).version).toBe(draft.version);
  });
  it('schema draft edited without mutating published schema', async () => {
    const f = await spaFixture(db), before = await db.spaSchemaVersion.findFirstOrThrow({ where: { typeId: f.type.id } });
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { name: 'Changed' });
    expect((await f.schemas.draft(f.actor, f.type.id)).snapshot.fields[0].name).toBe('Changed');
    expect(await db.spaSchemaVersion.findUnique({ where: { id: before.id } })).toEqual(before);
  });
  it('schema publish increments version and invalidates cache/search projections', async () => {
    const f = await spaFixture(db);
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { isSearchable: true });
    const publication = await f.publish();
    expect(publication.versionNumber).toBe(2);
    expect((await f.types.get(f.actor, f.type.id)).schemaVersion).toBe(2);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { entityId: f.type.id, eventType: 'SPA_SCHEMA_PUBLISHED' }, orderBy: { occurredAt: 'desc' } });
    expect(event.payload).toMatchObject({ schemaVersion: 2, checksum: publication.checksum });
    const created = await f.create('Fresh');
    expect((await db.spaItem.findUniqueOrThrow({ where: { id: created.id } })).schemaVersion).toBe(2);
  });
  it('field type migration previews incompatible existing records', async () => {
    const f = await spaFixture(db), item = await f.create('Not an integer'), migrations = new SpaMigrationService(db);
    const queued = await migrations.queue(f.actor, f.type.id, { fieldId: f.field.id, targetType: 'INTEGER', mappingStrategy: 'STRICT' });
    await migrations.runDue();
    expect(await db.spaSchemaMigrationJob.findUnique({ where: { id: queued.jobId } })).toMatchObject({ status: 'FAILED', processedCount: 1 });
    expect(await db.spaItemValue.findFirst({ where: { itemId: item.id, fieldId: f.field.id } })).toMatchObject({ valueText: 'Not an integer' });
    expect((await f.types.get(f.actor, f.type.id)).schemaVersion).toBe(1);
  });
  it('publishing migration while conversion errors exist is blocked', async () => {
    const f = await spaFixture(db); await f.create('Invalid');
    const migrations = new SpaMigrationService(db), queued = await migrations.queue(f.actor, f.type.id,
      { fieldId: f.field.id, targetType: 'INTEGER', mappingStrategy: 'STRICT' });
    await migrations.runDue();
    await expect(f.publish(queued.jobId)).rejects.toMatchObject({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED' });
    expect(await db.spaSchemaVersion.count({ where: { typeId: f.type.id } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { entityId: f.type.id, eventType: 'SPA_SCHEMA_PUBLISHED' } })).toBe(1);
  });
  it('adding unique constraint to duplicate live data is rejected', async () => {
    const f = await spaFixture(db); await f.create('Same'); await f.create('same');
    const before = await f.schemas.draft(f.actor, f.type.id);
    await expect(f.schemas.uniqueConstraint(f.actor, f.type.id, { name: 'Unique', fieldCodes: ['VALUE'] }))
      .rejects.toMatchObject({ code: 'SPA_SCHEMA_DUPLICATE_VALUES' });
    expect((await f.schemas.draft(f.actor, f.type.id)).version).toBe(before.version);
  });
  it('field deactivation preserves prior item values', async () => {
    const f = await spaFixture(db), item = await f.create('History');
    const before = await db.spaItemValue.findFirstOrThrow({ where: { itemId: item.id } });
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { expectedVersion: 1 }, true); await f.publish();
    expect(await db.spaItemValue.findUnique({ where: { id: before.id } })).toEqual(before);
    await expect(f.create('New')).rejects.toMatchObject({ code: 'SPA_FIELD_PERMISSION_DENIED' });
  });
  it('unauthorized schema write and cross-workspace IDs rejected', async () => {
    const f = await spaFixture(db), foreign = await spaFixture(db);
    await expect(f.schemas.addField({ ...f.actor, grants: new Map() }, f.type.id,
      { code: 'FORBIDDEN', name: 'Denied', fieldType: 'TEXT' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(f.schemas.draft(f.actor, foreign.type.id)).rejects.toMatchObject({ code: 'SPA_TYPE_NOT_FOUND' });
    expect(await db.spaSchemaVersion.count({ where: { typeId: foreign.type.id } })).toBe(1);
  });
});

describe('Schema publication safeguards', () => {
  it('normalizes typed defaults and empty arrays exactly like Item persistence', async () => {
    const f = await spaFixture(db);
    await f.schemas.addField(f.actor, f.type.id, { code: 'COUNT', name: 'Count', fieldType: 'INTEGER', defaultValue: '7' });
    await f.schemas.addField(f.actor, f.type.id, { code: 'TAGS', name: 'Tags', fieldType: 'MULTI_LIST', options: [], defaultValue: [] });
    await f.schemas.uniqueConstraint(f.actor, f.type.id, { name: 'Empty list key', fieldCodes: ['TAGS'], ignoreNull: false });
    await f.publish(); await f.create('First');
    await expect(f.create('Second')).rejects.toMatchObject({ code: 'SPA_SCHEMA_DUPLICATE_VALUES' });
    const draft = await f.schemas.draft(f.actor, f.type.id);
    expect(draft.snapshot.fields.find(field => field.code === 'COUNT')!.defaultValue).toBe('7');
    const count = await db.spaItemValue.findFirstOrThrow({ where: { fieldId: draft.snapshot.fields.find(field => field.code === 'COUNT')!.id } });
    expect(count.valueNumber!.toString()).toBe('7');
  });
  it('requires an explicit value migration when validation would normalize existing data', async () => {
    const f = await spaFixture(db);
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { validation: { trim: false } });
    await f.publish();
    await f.create(' padded ');
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { validation: { trim: true } });
    await expect(f.publish()).rejects.toMatchObject({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED' });
    expect(await db.spaItemValue.findFirst({ where: { fieldId: f.field.id } })).toMatchObject({ valueText: ' padded ' });
    const migrations = new SpaMigrationService(db), queued = await migrations.queue(f.actor, f.type.id,
      { fieldId: f.field.id, targetType: 'TEXT', mappingStrategy: 'STRICT' });
    await migrations.runDue();
    await f.publish(queued.jobId);
    expect(await db.spaItemValue.findFirst({ where: { fieldId: f.field.id } })).toMatchObject({ valueText: 'padded' });
    expect(await db.spaSchemaMigrationValue.findFirst({ where: { jobId: queued.jobId } }))
      .toMatchObject({ originalValue: ' padded ', convertedValue: 'padded' });
  });
  it('rechecks duplicate live values created after a uniqueness preview and rolls back publication', async () => {
    const f = await spaFixture(db); await f.create('Value');
    await f.schemas.uniqueConstraint(f.actor, f.type.id, { name: 'Unique', fieldCodes: ['VALUE'] });
    await f.create('value');
    const before = await f.schemas.draft(f.actor, f.type.id);
    expect(await f.schemas.validate(f.actor, f.type.id, { draftVersion: before.version })).toMatchObject({ valid: false,
      issues: [{ code: 'SPA_SCHEMA_DUPLICATE_VALUES', affectedItems: 2 }] });
    await expect(f.publish()).rejects.toMatchObject({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED' });
    expect((await f.schemas.draft(f.actor, f.type.id)).version).toBe(before.version);
    expect(await db.spaSchemaVersion.count({ where: { typeId: f.type.id } })).toBe(1);
  });
  it('counts persisted nulls as missing required values and keeps zero valid', async () => {
    const f = await spaFixture(db, 'INTEGER'); await f.create(null); await f.create(0);
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { isRequired: true });
    const draft = await f.schemas.draft(f.actor, f.type.id);
    expect(await f.schemas.validate(f.actor, f.type.id, { draftVersion: draft.version })).toMatchObject({ valid: false,
      issues: [{ code: 'SPA_REQUIRED_FIELD_MISSING', affectedItems: 1 }] });
    await expect(f.publish()).rejects.toMatchObject({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED' });
  });
  it('blocks tightened validation while retaining incompatible values and evidence', async () => {
    const f = await spaFixture(db); await f.create('Too long');
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { validation: { maxLength: 3 } });
    await expect(f.publish()).rejects.toMatchObject({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED' });
    expect(await db.spaItemValue.findFirst({ where: { fieldId: f.field.id } })).toMatchObject({ valueText: 'Too long' });
    expect(await db.outboxEvent.count({ where: { entityId: f.type.id, eventType: 'SPA_SCHEMA_PUBLISHED' } })).toBe(1);
  });
  it('honors configured null and case policies and rejects repeated constraint fields', async () => {
    const f = await spaFixture(db); await f.create(null); await f.create(null); await f.create('Upper'); await f.create('upper');
    await expect(f.schemas.uniqueConstraint(f.actor, f.type.id, { name: 'Strict nulls', fieldCodes: ['VALUE'], ignoreNull: false }))
      .rejects.toMatchObject({ code: 'SPA_SCHEMA_DUPLICATE_VALUES' });
    await expect(f.schemas.uniqueConstraint(f.actor, f.type.id, { name: 'Repeated', fieldCodes: ['VALUE', 'VALUE'] }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await f.schemas.uniqueConstraint(f.actor, f.type.id, { name: 'Case sensitive', fieldCodes: ['VALUE'], caseInsensitive: false });
    await f.publish();
    await expect(f.create('Upper')).rejects.toMatchObject({ code: 'SPA_SCHEMA_DUPLICATE_VALUES' });
    await f.create('UPPER');
  });
  it('ignores trashed values but checks uniqueness again when restoring', async () => {
    const f = await spaFixture(db), item = await f.create('Reserved');
    await f.items.lifecycle(f.actor, f.type.id, item.id, { expectedVersion: 1 });
    await f.create('reserved');
    await f.schemas.uniqueConstraint(f.actor, f.type.id, { name: 'Live only', fieldCodes: ['VALUE'] }); await f.publish();
    await expect(f.items.lifecycle(f.actor, f.type.id, item.id, { expectedVersion: 2 }, true))
      .rejects.toMatchObject({ code: 'SPA_SCHEMA_DUPLICATE_VALUES' });
    expect((await db.spaItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('TRASHED');
  });
});
