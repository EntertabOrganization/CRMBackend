import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';

export type FileContentPurpose = 'DOWNLOAD' | 'PROCESS' | 'PUBLIC' | 'EDIT' | 'TEMPLATE';
export type FileContentAuthority = (actor: ActorContext, objectKey: string, purpose: FileContentPurpose) => Promise<void>;

/** Managed artifacts fail closed until an owning-domain authority is installed. */
export const defaultContentAuthority: FileContentAuthority = async (_actor, key) => {
  if (key.includes('/objects/artifacts/'))
    throw new AppError('FILE_ARTIFACT_AUTHORITY_UNAVAILABLE', 'Artifact authority is unavailable.', 503);
};
