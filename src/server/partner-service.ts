import type { User } from './domain';
import { AuditService } from './audit-service';
import { badRequest, forbidden, notFound } from './errors';
import type { InMemoryStore } from './store';

export class PartnerService {
  constructor(private readonly store: InMemoryStore) {}

  submitApplication(user: User, input: { phone: string; partnerName: string; country: string; website?: string | null; businessDescription: string }) {
    for (const field of ['phone', 'partnerName', 'country', 'businessDescription'] as const) {
      if (typeof input?.[field] !== 'string' || !input[field].trim()) {
        throw badRequest('VALIDATION_ERROR', `${field} is required.`);
      }
    }
    const application = {
      id: this.store.id(),
      userId: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: input.phone,
      partnerName: input.partnerName,
      country: input.country,
      website: input.website ?? null,
      businessDescription: input.businessDescription,
      status: 'PENDING' as const,
      isDeleted: false,
    };
    this.store.state.partnerApplications.push(application);
    new AuditService(this.store).write({
      actorUserId: user.id,
      action: 'PARTNER.APPLICATION_SUBMITTED',
      entityType: 'PartnerApplication',
      entityId: application.id,
      afterData: application,
    });
    return application;
  }

  approve(platformAdmin: boolean, actorUserId: string, applicationId: string) {
    if (!platformAdmin) throw forbidden('Platform admin access is required.');
    const application = this.store.state.partnerApplications.find((item) => item.id === applicationId && item.status === 'PENDING');
    if (!application) throw notFound('Partner application');
    application.status = 'APPROVED';
    const partnerRole = { id: this.store.id(), name: 'Partner Owner', isOwnerRole: true, isDeleted: false };
    const partner = {
      id: this.store.id(),
      name: application.partnerName,
      country: application.country,
      website: application.website,
      businessDescription: application.businessDescription,
      status: 'ACTIVE' as const,
      defaultDiscount: 10,
      settings: {},
      meta: null,
      isDeleted: false,
    };
    const membership = {
      id: this.store.id(),
      partnerId: partner.id,
      userId: application.userId,
      partnerRoleId: partnerRole.id,
      status: 'ACTIVE' as const,
      isDeleted: false,
    };
    this.store.state.partnerRoles.push(partnerRole);
    this.store.state.partners.push(partner);
    this.store.state.partnerMemberships.push(membership);
    new AuditService(this.store).write({
      partnerId: partner.id,
      actorUserId,
      action: 'PARTNER.APPLICATION_APPROVED',
      entityType: 'PartnerApplication',
      entityId: application.id,
    });
    new AuditService(this.store).write({
      partnerId: partner.id,
      actorUserId,
      action: 'PARTNER.CREATED',
      entityType: 'Partner',
      entityId: partner.id,
    });
    return { partner, membership };
  }
}
