import { actorOf, addMember, CRM_READ, CRM_READ_UPDATE, expectAppError, fullApp, otherTenant } from './support/domain';

type App = Awaited<ReturnType<typeof fullApp>>;

const create = (t: App, input: Record<string, unknown>) => t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'CONTACT', ...input }) as any;

function contactFields(t: App, contact: { id: string }) {
  const actor = actorOf(t.app, t.user, t.workspace.id);
  return t.app.fields.decorate(actor, 'CONTACT', [contact as any])[0].customFields as Record<string, any>;
}

const newContact = (t: App, customFields?: Record<string, unknown>, user = t.user) =>
  t.app.crmCore.createContact(user, t.workspace.id, { firstName: 'Nadine', lastName: 'Saleh', customFields });

describe('Custom Fields - definitions, types and values', () => {
  it('creates a field with generated immutable code unique per workspace + entity type', async () => {
    const t = await fullApp();
    const first = create(t, { label: 'Customer Industry', fieldType: 'TEXT' });
    const second = create(t, { label: 'Customer Industry', fieldType: 'TEXT' });
    expect(first.code).toBe('customer_industry');
    expect(second.code).toBe('customer_industry_2');
    await expectAppError(() => create(t, { label: 'Other', code: 'customer_industry', fieldType: 'TEXT' }), 'CUSTOM_FIELD_CODE_CONFLICT', 409);
    await expectAppError(() => create(t, { label: 'Bad', code: 'Not Snake', fieldType: 'TEXT' }), 'FIELD_VALIDATION_FAILED');
    // The code is an API identity: it never follows label edits and cannot be changed.
    const renamed = t.app.fields.definitions.update(t.user, t.workspace.id, first.id, { version: first.version, label: 'Industry' }) as any;
    expect(renamed.code).toBe('customer_industry');
    await expectAppError(() => t.app.fields.definitions.update(t.user, t.workspace.id, first.id, { version: renamed.version, code: 'changed' }), 'CUSTOM_FIELD_IMMUTABLE', 400);
  });

  it('keeps a deactivated field code reserved', async () => {
    const t = await fullApp();
    const field = create(t, { label: 'Legacy', fieldType: 'TEXT' });
    t.app.fields.definitions.deactivate(t.user, t.workspace.id, field.id);
    await expectAppError(() => create(t, { label: 'Legacy again', code: 'legacy', fieldType: 'TEXT' }), 'CUSTOM_FIELD_CODE_CONFLICT');
  });

  it('allows the same field code on another entity type and another workspace', async () => {
    const t = await fullApp();
    const other = await otherTenant(t.app);
    const contact = create(t, { label: 'Region', fieldType: 'TEXT' });
    const company = create(t, { entityType: 'COMPANY', label: 'Region', fieldType: 'TEXT' });
    const foreign = t.app.fields.definitions.create(other.user, other.workspace.id, { entityType: 'CONTACT', label: 'Region', fieldType: 'TEXT' }) as any;
    expect([contact.code, company.code, foreign.code]).toEqual(['region', 'region', 'region']);
  });

  it('supports all locked initial field types including FILE and ADDRESS', async () => {
    const t = await fullApp();
    const specs: Array<Record<string, unknown>> = [
      { fieldType: 'TEXT' },
      { fieldType: 'TEXTAREA' },
      { fieldType: 'INTEGER' },
      { fieldType: 'DECIMAL' },
      { fieldType: 'BOOLEAN' },
      { fieldType: 'DATE' },
      { fieldType: 'DATETIME' },
      { fieldType: 'LIST', options: [{ label: 'A' }] },
      { fieldType: 'MULTI_LIST', options: [{ label: 'A' }] },
      { fieldType: 'PHONE' },
      { fieldType: 'EMAIL' },
      { fieldType: 'URL' },
      { fieldType: 'MONEY' },
      { fieldType: 'USER_REFERENCE' },
      { fieldType: 'CRM_REFERENCE', referenceConfig: { allowedEntityTypes: ['DEAL'] } },
      { fieldType: 'FILE' },
      { fieldType: 'ADDRESS' },
    ];
    const created = specs.map((spec, index) => create(t, { label: `Field ${index}`, ...spec }));
    expect(created.map((field: any) => field.fieldType)).toEqual(specs.map((spec) => spec.fieldType));
    expect(created.find((field: any) => field.fieldType === 'MULTI_LIST').isMultiple).toBe(true);
    await expectAppError(() => create(t, { label: 'Nope', fieldType: 'FORMULA' }), 'CUSTOM_FIELD_TYPE_UNSUPPORTED');
    await expectAppError(() => create(t, { label: 'Multi bool', fieldType: 'BOOLEAN', isMultiple: true }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => create(t, { label: 'Bad target', fieldType: 'CRM_REFERENCE', referenceConfig: { allowedEntityTypes: ['ROBOT'] } }), 'FIELD_VALIDATION_FAILED');
  });

  it('rejects unsafe or invalid type configuration when the admin saves it', async () => {
    const t = await fullApp();
    await expectAppError(() => create(t, { label: 'Bad regex', fieldType: 'TEXT', validationConfig: { pattern: '(a+)+$' } }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => create(t, { label: 'Broken regex', fieldType: 'TEXT', validationConfig: { pattern: '([' } }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => create(t, { label: 'Range', fieldType: 'INTEGER', validationConfig: { minimum: 10, maximum: 1 } }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => create(t, { label: 'Unknown key', fieldType: 'TEXT', validationConfig: { shout: true } }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => create(t, { label: 'Sortable multi', fieldType: 'TEXT', isMultiple: true, sortable: true }), 'FIELD_VALIDATION_FAILED');
  });

  it('validates every supported type with stable field errors', async () => {
    const t = await fullApp();
    create(t, { label: 'Note', code: 'note', fieldType: 'TEXT', validationConfig: { minLength: 2, maxLength: 5, pattern: '^[a-z]+$' } });
    create(t, { label: 'Users', code: 'users', fieldType: 'INTEGER', validationConfig: { minimum: 1, maximum: 100000 } });
    create(t, { label: 'Ratio', code: 'ratio', fieldType: 'DECIMAL', validationConfig: { scale: 2 } });
    create(t, { label: 'Vip', code: 'vip', fieldType: 'BOOLEAN' });
    create(t, { label: 'Renewal', code: 'renewal', fieldType: 'DATE' });
    create(t, { label: 'Signed', code: 'signed', fieldType: 'DATETIME' });
    create(t, { label: 'Mail', code: 'mail', fieldType: 'EMAIL' });
    create(t, { label: 'Tel', code: 'tel', fieldType: 'PHONE' });
    create(t, { label: 'Site', code: 'site', fieldType: 'URL' });
    create(t, { label: 'Budget', code: 'budget', fieldType: 'MONEY', validationConfig: { currencies: ['USD', 'EUR'], maximum: '1000' } });
    create(t, { label: 'Office', code: 'office', fieldType: 'ADDRESS' });

    const error = await expectAppError(
      () =>
        newContact(t, {
          note: 'ABCDEFG',
          users: 1_000_000,
          ratio: '1.234',
          vip: 'yes',
          renewal: '2027-02-30',
          signed: '2027-01-01T10:00:00',
          mail: 'nope',
          tel: '12',
          site: 'ftp://x.example',
          budget: { amount: '5000', currency: 'GBP' },
          office: { line1: '1 Main St', planet: 'Mars' },
        }),
      'FIELD_VALIDATION_FAILED',
    );
    const fields = error.details.fields as Record<string, Array<{ code: string }>>;
    // All safe violations come back together.
    expect(Object.keys(fields).sort()).toEqual(['budget', 'mail', 'note', 'office', 'ratio', 'renewal', 'signed', 'site', 'tel', 'users', 'vip']);
    expect(fields.note[0].code).toMatch(/MAX_LENGTH|PATTERN_MISMATCH/);
    expect(fields.users[0].code).toBe('MAX_VALUE');
    expect(fields.vip[0].code).toBe('INVALID_TYPE');
    expect(fields.budget[0].code).toBe('INVALID_CURRENCY');

    const ok = newContact(t, {
      note: 'abc',
      users: 400,
      ratio: '12.5',
      vip: false,
      renewal: '2027-03-01',
      signed: '2027-01-01T10:00:00+02:00',
      mail: ' Sales@Example.COM ',
      tel: '+1 (202) 555-0123',
      site: 'https://example.com/path',
      budget: { amount: '125.50', currency: 'usd' },
      office: { line1: '100 Main St', city: 'Edmonton', countryCode: 'ca' },
    });
    expect(contactFields(t, ok)).toEqual({
      note: 'abc',
      users: 400,
      ratio: '12.5',
      vip: false,
      renewal: '2027-03-01',
      signed: '2027-01-01T08:00:00.000Z',
      mail: 'sales@example.com',
      tel: '+12025550123',
      site: 'https://example.com/path',
      budget: { amount: '125.5', currency: 'USD' },
      office: { line1: '100 Main St', city: 'Edmonton', countryCode: 'CA' },
    });
  });

  it('stores custom values using typed storage and preserves multi-value order', async () => {
    const t = await fullApp();
    const list = create(t, { label: 'Tags', code: 'tags', fieldType: 'MULTI_LIST', options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }] });
    create(t, { label: 'Users', code: 'users', fieldType: 'INTEGER' });
    create(t, { label: 'Phones', code: 'phones', fieldType: 'PHONE', isMultiple: true });
    create(t, { label: 'Budget', code: 'budget', fieldType: 'MONEY' });
    create(t, { label: 'Renewal', code: 'renewal', fieldType: 'DATE' });
    const [alpha, beta, gamma] = list.options;

    const contact = newContact(t, {
      tags: [gamma.id, alpha.code, beta.id],
      users: 7,
      phones: ['+12025550101', '+12025550102', '+12025550103'],
      budget: { amount: '10.25', currency: 'USD' },
      renewal: '2027-03-01',
    });
    const rows = t.app.store.state.crmCustomFieldValues.filter((row) => row.entityId === contact.id);
    const usersRow = rows.find((row) => row.valueInteger === 7)!;
    // One typed column populated, the rest empty: never a single untyped blob.
    expect(usersRow).toMatchObject({ valueText: null, valueDecimal: null, valueBoolean: null, valueDate: null, valueUuid: null, valueJson: null });
    const moneyRow = rows.find((row) => row.valueDecimal !== null)!;
    expect(moneyRow).toMatchObject({ valueDecimal: '10.25', valueText: 'USD', valueInteger: null });
    expect(rows.find((row) => row.valueDate)!.valueDate!.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    expect(rows.filter((row) => row.fieldId === list.id).map((row) => [row.ordinal, row.valueUuid])).toEqual([
      [0, gamma.id],
      [1, alpha.id],
      [2, beta.id],
    ]);
    expect(contactFields(t, contact).tags).toEqual([gamma.id, alpha.id, beta.id]);
    expect(contactFields(t, contact).phones).toEqual(['+12025550101', '+12025550102', '+12025550103']);

    // Replacement semantics: omitted keeps, present replaces the whole ordered set, [] clears.
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, customFields: { tags: [beta.id] } });
    expect(contactFields(t, contact).tags).toEqual([beta.id]);
    expect(contactFields(t, contact).users).toBe(7);
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, customFields: { tags: [], users: null } });
    expect(contactFields(t, contact).tags).toEqual([]);
    expect(contactFields(t, contact).users).toBeNull();
    // Duplicates are meaningless for selections.
    await expectAppError(() => newContact(t, { tags: [alpha.id, alpha.id] }), 'FIELD_VALIDATION_FAILED');
  });

  it('applies static defaults only on create when the field is omitted', async () => {
    const t = await fullApp();
    create(t, { label: 'Tier', code: 'tier', fieldType: 'TEXT', staticDefaultValue: 'standard' });
    create(t, { label: 'Score', code: 'score', fieldType: 'INTEGER', staticDefaultValue: 0 });
    const withDefault = newContact(t);
    expect(contactFields(t, withDefault)).toMatchObject({ tier: 'standard', score: 0 });
    // Explicit null is validated as supplied, never silently replaced by the default.
    const explicitNull = newContact(t, { tier: null });
    expect(contactFields(t, explicitNull).tier).toBeNull();
    // Updates never re-apply defaults, and changing a default does not backfill.
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', explicitNull.id, { expectedVersion: explicitNull.version, firstName: 'Changed' });
    expect(contactFields(t, explicitNull).tier).toBeNull();
    const field = t.app.store.state.crmCustomFields.find((item) => item.code === 'tier')!;
    t.app.fields.definitions.update(t.user, t.workspace.id, field.id, { version: field.version, staticDefaultValue: 'premium' });
    expect(contactFields(t, withDefault).tier).toBe('standard');
    await expectAppError(() => create(t, { label: 'Bad default', fieldType: 'INTEGER', staticDefaultValue: 'abc' }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => create(t, { label: 'Ref default', fieldType: 'USER_REFERENCE', staticDefaultValue: t.user.id }), 'FIELD_VALIDATION_FAILED');
  });

  it('rejects cross-workspace user, CRM and file references', async () => {
    const t = await fullApp();
    const other = await otherTenant(t.app);
    create(t, { label: 'Owner ref', code: 'owner_ref', fieldType: 'USER_REFERENCE' });
    create(t, { label: 'Deal ref', code: 'deal_ref', fieldType: 'CRM_REFERENCE', referenceConfig: { allowedEntityTypes: ['DEAL', 'COMPANY'] } });
    create(t, { label: 'Attachment', code: 'attachment', fieldType: 'FILE' });
    const foreignCompany = t.app.crmCore.createCompany(other.user, other.workspace.id, { name: 'Foreign Co' });
    t.files.register(other.workspace.id, '11111111-1111-4111-8111-111111111111');
    t.files.register(t.workspace.id, '22222222-2222-4222-8222-222222222222');

    const error = await expectAppError(
      () =>
        newContact(t, {
          owner_ref: other.user.id,
          deal_ref: { entityType: 'COMPANY', entityId: foreignCompany.id },
          attachment: '11111111-1111-4111-8111-111111111111',
        }),
      'FIELD_VALIDATION_FAILED',
    );
    expect(Object.keys(error.details.fields).sort()).toEqual(['attachment', 'deal_ref', 'owner_ref']);
    // Same-tenant references work; the file is stored once and only referenced.
    const company = t.app.crmCore.createCompany(t.user, t.workspace.id, { name: 'Home Co' });
    const ok = newContact(t, {
      owner_ref: t.user.id,
      deal_ref: { entityType: 'COMPANY', entityId: company.id },
      attachment: '22222222-2222-4222-8222-222222222222',
    });
    expect(contactFields(t, ok)).toEqual({
      owner_ref: t.user.id,
      deal_ref: { entityType: 'COMPANY', entityId: company.id },
      attachment: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('refuses file references until the Files module is wired instead of trusting unknown ids', async () => {
    const t = await fullApp();
    t.app.setFilePort(new (require('@/src/server/ports').UnconfiguredFilePort)());
    create(t, { label: 'Attachment', code: 'attachment', fieldType: 'FILE' });
    const error = await expectAppError(() => newContact(t, { attachment: '22222222-2222-4222-8222-222222222222' }), 'FIELD_VALIDATION_FAILED');
    expect(error.details.fields.attachment[0].code).toBe('FILES_UNAVAILABLE');
  });

  it('keeps historical inactive user references but excludes them from new selection by default', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'leaver', CRM_READ);
    create(t, { label: 'Owner ref', code: 'owner_ref', fieldType: 'USER_REFERENCE' });
    const contact = newContact(t, { owner_ref: member.user.id });
    // The member leaves the workspace.
    const membership = t.app.store.state.workspaceMemberships.find((item) => item.userId === member.user.id && item.workspaceId === t.workspace.id)!;
    membership.isDeleted = true;
    expect(contactFields(t, contact).owner_ref).toBe(member.user.id);
    // Unrelated saves preserve the stored reference (even when the same value is sent back).
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, firstName: 'Still fine', customFields: { owner_ref: member.user.id } });
    expect(contactFields(t, contact).owner_ref).toBe(member.user.id);
    // ...but a NEW selection of the departed user is refused.
    await expectAppError(() => newContact(t, { owner_ref: member.user.id }), 'FIELD_VALIDATION_FAILED');
  });

  it('deactivates a used list option without corrupting stored values, and rejects new selection of it', async () => {
    const t = await fullApp();
    const field = create(t, { label: 'Industry', code: 'industry', fieldType: 'LIST', options: [{ label: 'Finance' }, { label: 'Health' }] });
    const [finance, health] = field.options;
    const contact = newContact(t, { industry: finance.id });
    const listed = t.app.fields.definitions.listOptions(t.user, t.workspace.id, field.id) as any[];
    expect(listed.find((option) => option.id === finance.id).inUse).toBe(true);
    t.app.fields.definitions.setOptionActive(t.user, t.workspace.id, field.id, finance.id, false);
    expect(contactFields(t, contact).industry).toBe(finance.id);
    const error = await expectAppError(() => newContact(t, { industry: finance.id }), 'FIELD_VALIDATION_FAILED');
    expect(error.details.fields.industry[0].code).toBe('FIELD_OPTION_INACTIVE');
    // The unchanged historical value can be re-saved; other options remain selectable; identity survives label edits.
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, customFields: { industry: finance.id } });
    const option = t.app.fields.definitions.updateOption(t.user, t.workspace.id, field.id, health.id, { label: 'Healthcare', version: health.version }) as any;
    expect(option.id).toBe(health.id);
    expect(option.code).toBe(health.code);
    expect(contactFields(t, newContact(t, { industry: health.id })).industry).toBe(health.id);
  });

  it('rejects direct type change when values exist and requires explicit migration', async () => {
    const t = await fullApp();
    const field = create(t, { label: 'Users', code: 'users', fieldType: 'TEXT' });
    newContact(t, { users: '42' });
    const error = await expectAppError(() => t.app.fields.definitions.update(t.user, t.workspace.id, field.id, { version: field.version, fieldType: 'INTEGER' }), 'CUSTOM_FIELD_TYPE_MIGRATION_REQUIRED', 409);
    expect(error.details.valueCount).toBe(1);
    // Without stored values the type may change through PATCH.
    const empty = create(t, { label: 'Fresh', code: 'fresh', fieldType: 'TEXT' });
    expect((t.app.fields.definitions.update(t.user, t.workspace.id, empty.id, { version: empty.version, fieldType: 'INTEGER' }) as any).fieldType).toBe('INTEGER');
  });

  it('migrates a field type explicitly: preview never mutates, failures are reported, success converts atomically', async () => {
    const t = await fullApp();
    const field = create(t, { label: 'Users', code: 'users', fieldType: 'TEXT' });
    const good = newContact(t, { users: '42' });
    const bad = newContact(t, { users: 'lots' });
    const before = JSON.stringify(t.app.store.state.crmCustomFieldValues);
    const preview = t.app.fields.migrations.preview(t.user, t.workspace.id, field.id, { targetType: 'INTEGER' }) as any;
    expect(preview.summary).toMatchObject({ totalValues: 2, convertible: 1, nonConvertible: 1 });
    expect(JSON.stringify(t.app.store.state.crmCustomFieldValues)).toBe(before);

    // All-or-nothing: one non-convertible value leaves the original field authoritative and never nulls anything.
    const failed = t.app.fields.migrations.start(t.user, t.workspace.id, field.id, { targetType: 'INTEGER', version: field.version }) as any;
    expect(failed.status).toBe('FAILED');
    expect(failed.report.examples[0].entityId).toBe(bad.id);
    expect(t.app.store.state.crmCustomFields.find((item) => item.id === field.id)!.fieldType).toBe('TEXT');
    expect(contactFields(t, bad).users).toBe('lots');

    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', bad.id, { expectedVersion: bad.version, customFields: { users: '7' } });
    const current = t.app.store.state.crmCustomFields.find((item) => item.id === field.id)!;
    const done = t.app.fields.migrations.start(t.user, t.workspace.id, field.id, { targetType: 'INTEGER', version: current.version, idempotencyKey: 'migrate-1' }) as any;
    expect(done.status).toBe('COMPLETED');
    expect(contactFields(t, good).users).toBe(42);
    expect(contactFields(t, bad).users).toBe(7);
    // Retrying with the same key is a no-op that returns the same migration.
    const retry = t.app.fields.migrations.start(t.user, t.workspace.id, field.id, { targetType: 'INTEGER', version: 999, idempotencyKey: 'migrate-1' }) as any;
    expect(retry.id).toBe(done.id);
    expect(t.app.store.state.crmCustomFieldMigrations.filter((item) => item.status === 'COMPLETED')).toHaveLength(1);
  });

  it('blocks hard delete when values or dependencies exist', async () => {
    const t = await fullApp();
    const used = create(t, { label: 'Used', code: 'used', fieldType: 'TEXT' });
    newContact(t, { used: 'x' });
    await expectAppError(() => t.app.fields.definitions.hardDelete(t.user, t.workspace.id, used.id), 'CUSTOM_FIELD_IN_USE', 409); // still active
    t.app.fields.definitions.deactivate(t.user, t.workspace.id, used.id);
    const error = await expectAppError(() => t.app.fields.definitions.hardDelete(t.user, t.workspace.id, used.id), 'CUSTOM_FIELD_IN_USE', 409);
    expect(error.details.valueCount).toBe(1);

    const unused = create(t, { label: 'Unused', code: 'unused', fieldType: 'TEXT' });
    const rule = t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'CONTACT', target: { kind: 'CUSTOM', fieldId: unused.id } }) as any;
    t.app.fields.requirements.setActive(t.user, t.workspace.id, rule.id, false);
    t.app.fields.definitions.deactivate(t.user, t.workspace.id, unused.id);
    await expectAppError(() => t.app.fields.definitions.hardDelete(t.user, t.workspace.id, unused.id), 'CUSTOM_FIELD_DEPENDENCIES_EXIST', 409);
    t.app.fields.requirements.delete(t.user, t.workspace.id, rule.id);
    expect(t.app.fields.definitions.hardDelete(t.user, t.workspace.id, unused.id)).toEqual({ id: unused.id, deleted: true });
    expect(t.app.store.state.crmCustomFields.some((item) => item.id === unused.id)).toBe(false);
  });

  it('reports dependencies before deactivation and does not silently break active rules', async () => {
    const t = await fullApp();
    const field = create(t, { label: 'Contract', code: 'contract', fieldType: 'TEXT' });
    const rule = t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'CONTACT', target: { kind: 'CUSTOM', fieldId: field.id } }) as any;
    const report = t.app.fields.definitions.getDependencies(t.user, t.workspace.id, field.id) as any;
    expect(report.blocking).toBe(1);
    expect(report.groups.REQUIRED_FIELDS[0].id).toBe(rule.id);
    const error = await expectAppError(() => t.app.fields.definitions.deactivate(t.user, t.workspace.id, field.id), 'CUSTOM_FIELD_DEPENDENCIES_EXIST', 409);
    expect(error.details.dependencies).toHaveLength(1);
    expect(t.app.store.state.crmCustomFields.find((item) => item.id === field.id)!.isActive).toBe(true);
    t.app.fields.requirements.setActive(t.user, t.workspace.id, rule.id, false);
    expect((t.app.fields.definitions.deactivate(t.user, t.workspace.id, field.id) as any).isActive).toBe(false);
    // Deactivation preserves stored values and simply stops normal rendering/new writes.
    expect(t.app.store.state.crmCustomFieldValues.length).toBe(0);
  });

  it('preserves stored values when a field is deactivated and hides it from normal responses', async () => {
    const t = await fullApp();
    const field = create(t, { label: 'Region', code: 'region', fieldType: 'TEXT' });
    const contact = newContact(t, { region: 'North' });
    t.app.fields.definitions.deactivate(t.user, t.workspace.id, field.id);
    expect(t.app.store.state.crmCustomFieldValues.filter((row) => row.fieldId === field.id)).toHaveLength(1);
    expect(contactFields(t, contact)).toEqual({});
    const error = await expectAppError(() => newContact(t, { region: 'South' }), 'FIELD_VALIDATION_FAILED');
    expect(error.details.fields.region[0].code).toBe('CUSTOM_FIELD_INACTIVE');
    t.app.fields.definitions.activate(t.user, t.workspace.id, field.id);
    expect(contactFields(t, contact).region).toBe('North');
  });

  it('returns a version conflict for stale configuration updates and reorders', async () => {
    const t = await fullApp();
    const a = create(t, { label: 'A', fieldType: 'TEXT' });
    t.app.fields.definitions.update(t.user, t.workspace.id, a.id, { version: a.version, label: 'A2' });
    const conflict = await expectAppError(() => t.app.fields.definitions.update(t.user, t.workspace.id, a.id, { version: a.version, label: 'A3' }), 'CONFIGURATION_VERSION_CONFLICT', 409);
    expect(conflict.details.currentVersion).toBe(a.version + 1);
    await expectAppError(() => t.app.fields.definitions.update(t.user, t.workspace.id, a.id, { label: 'no version' }), 'CONFIGURATION_VERSION_REQUIRED', 400);
  });

  it('atomically reorders fields, bumps the schema version and rejects stale or partial orders', async () => {
    const t = await fullApp();
    const a = create(t, { label: 'A', fieldType: 'TEXT' });
    const b = create(t, { label: 'B', fieldType: 'TEXT' });
    const c = create(t, { label: 'C', fieldType: 'TEXT' });
    const version = t.app.fields.support.schemaVersion(t.workspace.id, 'CONTACT');
    const result = t.app.fields.definitions.reorder(t.user, t.workspace.id, { orderedFieldIds: [c.id, a.id, b.id], expectedSchemaVersion: version }) as any;
    expect(result.schemaVersion).toBe(version + 1);
    expect(result.fields.map((field: any) => field.id)).toEqual([c.id, a.id, b.id]);
    const order = t.app.store.state.crmCustomFields.filter((field) => field.entityType === 'CONTACT').sort((x, y) => x.sortOrder - y.sortOrder).map((field) => field.code);
    expect(order).toEqual(['c', 'a', 'b']);
    // A second admin working from the old version must not overwrite the newer order.
    await expectAppError(() => t.app.fields.definitions.reorder(t.user, t.workspace.id, { orderedFieldIds: [a.id, b.id, c.id], expectedSchemaVersion: version }), 'CONFIGURATION_VERSION_CONFLICT', 409);
    await expectAppError(() => t.app.fields.definitions.reorder(t.user, t.workspace.id, { orderedFieldIds: [a.id, b.id], expectedSchemaVersion: version + 1 }), 'FIELD_REORDER_INVALID', 400);
    const after = t.app.store.state.crmCustomFields.filter((field) => field.entityType === 'CONTACT').sort((x, y) => x.sortOrder - y.sortOrder).map((field) => field.code);
    expect(after).toEqual(['c', 'a', 'b']);
  });

  it('rejects foreign-workspace field ids/options/references/stages even when UUIDs are valid', async () => {
    const t = await fullApp();
    const other = await otherTenant(t.app);
    const foreign = t.app.fields.definitions.create(other.user, other.workspace.id, { entityType: 'CONTACT', label: 'Foreign', fieldType: 'LIST', options: [{ label: 'X' }] }) as any;
    await expectAppError(() => t.app.fields.definitions.get(t.user, t.workspace.id, foreign.id), 'CUSTOM_FIELD_NOT_FOUND', 404);
    await expectAppError(() => t.app.fields.definitions.update(t.user, t.workspace.id, foreign.id, { version: 1, label: 'x' }), 'CUSTOM_FIELD_NOT_FOUND', 404);
    await expectAppError(() => t.app.fields.definitions.setOptionActive(t.user, t.workspace.id, foreign.id, foreign.options[0].id, false), 'CUSTOM_FIELD_NOT_FOUND', 404);
    await expectAppError(() => t.app.fields.definitions.reorder(t.user, t.workspace.id, { orderedFieldIds: [foreign.id], expectedSchemaVersion: 1 }), 'CUSTOM_FIELD_NOT_FOUND', 404);
    // Option ids of another tenant's field are not selectable.
    const mine = create(t, { label: 'Mine', code: 'mine', fieldType: 'LIST', options: [{ label: 'Y' }] });
    void mine;
    const error = await expectAppError(() => newContact(t, { mine: foreign.options[0].id }), 'FIELD_VALIDATION_FAILED');
    expect(error.details.fields.mine[0].code).toBe('FIELD_OPTION_NOT_FOUND');
    // Requirement rules cannot point at another workspace's field, pipeline or stage.
    await expectAppError(() => t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'CONTACT', target: { kind: 'CUSTOM', fieldId: foreign.id } }), 'CUSTOM_FIELD_NOT_FOUND', 404);
    const foreignPipeline = t.app.store.state.crmPipelines.find((pipeline) => pipeline.workspaceId === other.workspace.id && pipeline.entityType === 'DEAL')!;
    const foreignStage = t.app.store.state.crmStages.find((stage) => stage.pipelineId === foreignPipeline.id)!;
    const dealField = create(t, { entityType: 'DEAL', label: 'Deal note', code: 'deal_note', fieldType: 'TEXT' });
    await expectAppError(() => t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'DEAL', target: { kind: 'CUSTOM', fieldId: dealField.id }, pipelineId: foreignPipeline.id }), 'NOT_FOUND', 404);
    const ownPipeline = t.app.store.state.crmPipelines.find((pipeline) => pipeline.workspaceId === t.workspace.id && pipeline.entityType === 'DEAL')!;
    await expectAppError(() => t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'DEAL', target: { kind: 'CUSTOM', fieldId: dealField.id }, pipelineId: ownPipeline.id, stageId: foreignStage.id }), 'NOT_FOUND', 404);
  });

  it('requires custom_fields.manage for administration and never for reading values', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'plain', CRM_READ_UPDATE);
    await expectAppError(() => t.app.fields.definitions.create(member.user, t.workspace.id, { entityType: 'CONTACT', label: 'X', fieldType: 'TEXT' }), 'PERMISSION_DENIED', 403);
    await expectAppError(() => t.app.fields.definitions.list(member.user, t.workspace.id, new URLSearchParams()), 'PERMISSION_DENIED', 403);
    // A manager with the permission but only own scope is refused: configuration is workspace-wide.
    const scoped = await addMember(t.app, t.user, t.workspace.id, 'scoped', [['custom_fields.manage', 'OWN']]);
    await expectAppError(() => t.app.fields.definitions.list(scoped.user, t.workspace.id, new URLSearchParams()), 'PERMISSION_DENIED', 403);
    const manager = await addMember(t.app, t.user, t.workspace.id, 'manager', [['custom_fields.manage', 'WORKSPACE']]);
    expect(t.app.fields.definitions.create(manager.user, t.workspace.id, { entityType: 'CONTACT', label: 'Managed', fieldType: 'TEXT' })).toMatchObject({ code: 'managed' });
    // The plain member still reads/writes values through normal record permissions.
    create(t, { label: 'Region', code: 'region', fieldType: 'TEXT' });
    const contact = newContact(t, { region: 'North' }, member.user);
    expect(contactFields(t, contact).region).toBe('North');
  });

  it('omits hidden fields from record and schema responses, and rejects writes to them like unknown fields', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'sales', CRM_READ_UPDATE);
    const role = member.role.id;
    create(t, { label: 'Public note', code: 'public_note', fieldType: 'TEXT' });
    create(t, { label: 'Margin', code: 'margin', fieldType: 'DECIMAL', restrictions: [{ subjectType: 'ROLE', subjectId: role, restriction: 'HIDDEN' }] });
    const contact = newContact(t, { public_note: 'hello', margin: '12.5' });
    const asOwner = contactFields(t, contact);
    expect(asOwner).toEqual({ public_note: 'hello', margin: '12.5' });
    const memberActor = actorOf(t.app, member.user, t.workspace.id);
    const asMember = t.app.fields.decorate(memberActor, 'CONTACT', [contact])[0].customFields;
    expect(asMember).toEqual({ public_note: 'hello' });
    expect('margin' in asMember).toBe(false);
    const schema = t.app.fields.schema.getSchema(member.user, t.workspace.id, 'CONTACT', { surface: 'detail', entityId: contact.id }) as any;
    expect(schema.fields.map((field: any) => field.code)).toEqual(['public_note']);
    expect(JSON.stringify(schema)).not.toMatch(/margin|Margin/);
    // Hidden and unknown answer identically, so field existence is not disclosed.
    const hidden = await expectAppError(() => newContact(t, { margin: '1' }, member.user), 'FIELD_VALIDATION_FAILED');
    const unknown = await expectAppError(() => newContact(t, { nonexistent: '1' }, member.user), 'FIELD_VALIDATION_FAILED');
    expect(hidden.details.fields.margin[0]).toEqual({ code: 'UNKNOWN_FIELD', message: 'Unknown field.' });
    expect(unknown.details.fields.nonexistent[0]).toEqual({ code: 'UNKNOWN_FIELD', message: 'Unknown field.' });
  });

  it('rejects direct writes to a visible read-only field, and a field rule can only narrow record access', async () => {
    const t = await fullApp();
    const editor = await addMember(t.app, t.user, t.workspace.id, 'editor', CRM_READ_UPDATE);
    const reader = await addMember(t.app, t.user, t.workspace.id, 'reader', CRM_READ);
    const editorRole = editor.role.id;
    create(t, { label: 'Locked', code: 'locked', fieldType: 'TEXT', restrictions: [{ subjectType: 'ROLE', subjectId: editorRole, restriction: 'READ_ONLY' }] });
    create(t, { label: 'Open', code: 'open', fieldType: 'TEXT' });
    const contact = newContact(t, { locked: 'admin value', open: 'a' });

    const error = await expectAppError(
      () => t.app.crmCore.updateRecord(editor.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, customFields: { locked: 'hacked', open: 'b' } }),
      'FIELD_VALIDATION_FAILED',
    );
    expect(error.details.fields.locked[0].code).toBe('FIELD_EDIT_FORBIDDEN');
    // Nothing partial: the allowed field did not change either.
    expect(contactFields(t, contact)).toEqual({ locked: 'admin value', open: 'a' });
    const schema = t.app.fields.schema.getSchema(editor.user, t.workspace.id, 'CONTACT', { surface: 'edit', entityId: contact.id }) as any;
    expect(Object.fromEntries(schema.fields.map((field: any) => [field.code, field.readOnly]))).toEqual({ locked: true, open: false });

    // A reader has only READ on the record: no field rule can make anything editable.
    const readerSchema = t.app.fields.schema.getSchema(reader.user, t.workspace.id, 'CONTACT', { surface: 'edit', entityId: contact.id }) as any;
    expect(readerSchema.fields.every((field: any) => field.readOnly)).toBe(true);
    await expectAppError(() => t.app.crmCore.updateRecord(reader.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, customFields: { open: 'z' } }), 'PERMISSION_DENIED', 403);
    // No record permission at all: no field access either, and the schema request looks like a missing record.
    const stranger = await addMember(t.app, t.user, t.workspace.id, 'stranger', [['crm.company.read', 'WORKSPACE']]);
    await expectAppError(() => t.app.fields.schema.getSchema(stranger.user, t.workspace.id, 'CONTACT', { surface: 'detail', entityId: contact.id }), 'RESOURCE_NOT_FOUND_OR_FORBIDDEN', 404);
  });

  it('does not let API exposure flags bypass permission, and hides non-API fields from the API', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'api', CRM_READ_UPDATE);
    const role = member.role.id;
    create(t, { label: 'Secret', code: 'secret', fieldType: 'TEXT', availableInApi: true, restrictions: [{ subjectType: 'ROLE', subjectId: role, restriction: 'HIDDEN' }] });
    create(t, { label: 'Internal', code: 'internal', fieldType: 'TEXT', availableInApi: false, availableInForms: true });
    const contact = newContact(t, { secret: 's' });
    expect(t.app.fields.decorate(actorOf(t.app, member.user, t.workspace.id), 'CONTACT', [contact])[0].customFields).toEqual({});
    const error = await expectAppError(() => newContact(t, { internal: 'x' }), 'FIELD_VALIDATION_FAILED');
    expect(error.details.fields.internal[0].code).toBe('UNKNOWN_FIELD');
    // The Forms surface writes it through the same engine.
    const actor = actorOf(t.app, t.user, t.workspace.id);
    const prepared = t.app.fields.validateWrite({ actor, entityType: 'CONTACT', entityId: null, isCreate: true, supplied: { internal: 'via form' }, systemState: {}, origin: 'FORM' });
    expect([...prepared.changes.values()].map((entry) => entry.items)).toEqual([['via form']]);
  });

  it('writes the record and its custom values atomically', async () => {
    const t = await fullApp();
    create(t, { label: 'Users', code: 'users', fieldType: 'INTEGER', validationConfig: { minimum: 1 } });
    const before = t.app.store.state.crmContacts.length;
    await expectAppError(() => newContact(t, { users: 0 }), 'FIELD_VALIDATION_FAILED');
    expect(t.app.store.state.crmContacts.length).toBe(before);
    expect(t.app.store.state.crmCustomFieldValues).toHaveLength(0);
    const contact = newContact(t, { users: 5 });
    await expectAppError(
      () => t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, firstName: 'Renamed', customFields: { users: -1 } }),
      'FIELD_VALIDATION_FAILED',
    );
    expect(t.app.store.state.crmContacts.find((item) => item.id === contact.id)!.firstName).toBe('Nadine');
    expect(contactFields(t, contact).users).toBe(5);
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: contact.version, firstName: 'Renamed', customFields: { users: 6 } });
    expect(t.app.store.state.crmContacts.find((item) => item.id === contact.id)!.firstName).toBe('Renamed');
    expect(contactFields(t, contact).users).toBe(6);
    // Stale record version: nothing is written.
    await expectAppError(() => t.app.crmCore.updateRecord(t.user, t.workspace.id, 'CONTACT', contact.id, { expectedVersion: 1, customFields: { users: 9 } }), 'CRM_VERSION_CONFLICT', 409);
    expect(contactFields(t, contact).users).toBe(6);
  });

  it('records audit evidence and outbox events for configuration changes', async () => {
    const t = await fullApp();
    const field = create(t, { label: 'Audited', code: 'audited', fieldType: 'LIST', options: [{ label: 'One' }] });
    t.app.fields.definitions.update(t.user, t.workspace.id, field.id, { version: field.version, label: 'Audited 2' });
    t.app.fields.definitions.deactivate(t.user, t.workspace.id, field.id);
    const actions = t.app.store.state.auditLogs.map((log) => log.action);
    expect(actions).toEqual(expect.arrayContaining(['CUSTOM_FIELD.CREATED', 'CUSTOM_FIELD.UPDATED', 'CUSTOM_FIELD.DEACTIVATED']));
    const events = t.app.store.state.outboxEvents.filter((event) => event.eventType === 'FIELD_SCHEMA_CHANGED');
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].payload).toMatchObject({ entityType: 'CONTACT' });
    // Events carry a compact change summary, never field values.
    expect(JSON.stringify(events)).not.toMatch(/audited value/);
  });

  it('serves an authorized schema with defaults, options and the current schema version', async () => {
    const t = await fullApp();
    create(t, { label: 'Tier', code: 'tier', fieldType: 'LIST', options: [{ label: 'Gold' }, { label: 'Silver' }], staticDefaultValue: 'GOLD', showOnCreate: true, showOnEdit: false });
    const createSchema = t.app.fields.schema.getSchema(t.user, t.workspace.id, 'CONTACT', { surface: 'create' }) as any;
    const editSchema = t.app.fields.schema.getSchema(t.user, t.workspace.id, 'CONTACT', { surface: 'edit' }) as any;
    expect(createSchema.fields[0]).toMatchObject({ code: 'tier', type: 'LIST', readOnly: false, required: false });
    expect(createSchema.fields[0].options.map((option: any) => option.label)).toEqual(['Gold', 'Silver']);
    expect(editSchema.fields).toHaveLength(0);
    expect(createSchema.schemaVersion).toBeGreaterThan(1);
    await expectAppError(() => t.app.fields.schema.getSchema(t.user, t.workspace.id, 'ROBOT', {}), 'ENTITY_TYPE_NOT_FIELD_CAPABLE', 400);
  });
});
