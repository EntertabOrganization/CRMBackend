import { Injectable } from '@nestjs/common';
import { AuthModule as AuthDomain } from '../auth-module';

@Injectable()
export class AuthDomainService extends AuthDomain {}
