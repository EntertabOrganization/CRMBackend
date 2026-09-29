import { AppError } from '../errors';

export interface FormFileAdapter {
  begin(input:{workspaceId:string;formId:string;uploadId:string;mimeType:string;size:number}):{storageReference:string;uploadUrl:string};
  scan(input:{storageReference:string;mimeType:string;size:number}):Promise<'CLEAN'|'INFECTED'|'FAILED'>;
}
export class DeterministicFormFileAdapter implements FormFileAdapter {
  begin(input:{uploadId:string}){return{storageReference:`test/${input.uploadId}`,uploadUrl:`https://uploads.invalid/${input.uploadId}`};}
  async scan(input:{mimeType:string}){return input.mimeType==='application/x-malware'?'INFECTED' as const:'CLEAN' as const;}
}
export class UnconfiguredFormFileAdapter implements FormFileAdapter {
  begin():never{throw this.error();}
  scan():Promise<'CLEAN'|'INFECTED'|'FAILED'>{return Promise.reject(this.error());}
  private error(){return new AppError('FORM_FILE_PROVIDER_NOT_CONFIGURED','Public file storage/scanning provider is not configured.',503);}
}
