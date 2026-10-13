import { AccessService } from '../access-service';
import { AppError, isAppError } from '../errors';
import { hydrateState } from '../persistence';
import { InMemoryStore } from '../store';
import { requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { parse, uuid } from '../process-platform/dto';
import { RequisiteService } from './requisite-service';

/** Read-only adapter: current owning permissions and the complete Address chain are authoritative. */
export class RequisiteAddressAuthority {
  async assertReadable(tx: Tx, principal: Principal, addressId: string): Promise<void> {
    parse(uuid, addressId);
    principal = await resolvePrincipal(tx, principal.workspaceId, principal.userId);
    requirePermission(principal, 'requisite.read');
    // Keep the owning records stable until the caller commits its binding.
    await tx.$queryRaw`SELECT id FROM commercial_pack_records WHERE workspace_id=${principal.workspaceId}::uuid
      AND collection='requisiteAddresses' AND id=${addressId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT r.id FROM commercial_pack_records r JOIN commercial_pack_records a
      ON r.id::text=a.data->>'requisiteId' AND r.workspace_id=a.workspace_id
      WHERE a.workspace_id=${principal.workspaceId}::uuid AND a.id=${addressId}::uuid
        AND a.collection='requisiteAddresses' AND r.collection='requisites' FOR SHARE OF r`;
    const store = new InMemoryStore(await hydrateState(tx)), access = new AccessService(store);
    const user = store.state.users.find(row => row.id === principal.userId)!;
    try {
      new RequisiteService(store, access).getAddress(access.actor(user, principal.workspaceId), addressId);
    } catch (error) {
      if (!isAppError(error) || ![403, 404].includes(error.status)) throw error;
      throw new AppError('WAREHOUSE_ADDRESS_NOT_FOUND', 'Warehouse Address was not found.', 404);
    }
  }
}
