export type Field = { id: string; code: string; name: string; fieldType: string; isActive: boolean; isRequired: boolean;
  isMultiple: boolean; defaultValue?: unknown; referenceTypeId?: string; options: Array<{ id: string; code: string; label: string; isActive: boolean }> };
export type ItemPermissions = { actions: string[]; visibleFields: string[]; editableFields: string[]; transitions?: Array<{ pipelineId: string; stageId: string }> };

/** The form never echoes protected values or writes fields absent from the server's effective grant. */
export function itemPayload(fields: Field[], form: Record<string, unknown>, assignedUserId: string, title: string,
  editable: string[], expectedVersion?: number) {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.isActive || !editable.includes(field.code) || !(field.code in form)) continue;
    const raw = form[field.code];
    values[field.code] = raw === '' ? null : field.fieldType === 'INTEGER' && raw !== null
      ? Array.isArray(raw) ? raw.map(Number) : Number(raw) : raw;
  }
  return { title: title.trim(), assignedUserId, fieldValues: values, ...(expectedVersion ? { expectedVersion } : {}) };
}
export function canAct(permissions: ItemPermissions | null, action: string) { return !!permissions?.actions.includes('SPA.ITEM.' + action); }
export function cleanMatrix(matrix: Record<string, any>) {
  return { expectedVersion: matrix.version,
    rolePolicies: matrix.rolePolicies.map((r: any) => ({ roleId: r.roleId, action: r.action, scope: r.scope })),
    stagePolicies: matrix.stagePolicies.map((r: any) => ({ roleId: r.roleId, action: r.action, scope: r.scope, pipelineId: r.pipelineId, stageId: r.stageId })),
    fieldPolicies: matrix.fieldPolicies.map((r: any) => ({ fieldId: r.fieldId, subjectType: r.subjectType, subjectId: r.subjectId, canView: r.canView, canEdit: r.canEdit })) };
}
