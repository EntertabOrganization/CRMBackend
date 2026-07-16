import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { USERS_REPOSITORY } from '../constants/users.tokens';
import { GoogleAuthDto, SignInDto, SignUpDto } from '../dto/auth.dto';
import {
  GoogleAuthNotImplementedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  RoleNotAssignedNotFoundException,
  SignupCompanyPayloadIncompleteException,
  UserEmailAlreadyExistsException,
  UserRoleScopeInvalidException,
  UsersSchemaOutdatedException,
} from '../exceptions/user.exceptions';
import { AuthUserRecord, UsersRepository } from '../interfaces/users-repository.interface';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(USERS_REPOSITORY)
    private readonly usersRepository: UsersRepository,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async signup(signUpDto: SignUpDto) {
    try {
      const existingUser = await this.usersRepository.findAuthByEmail(signUpDto.email, { includeDeleted: true });
      if (existingUser) {
        throw new UserEmailAlreadyExistsException(signUpDto.email);
      }

      const passwordHash = this.hashPassword(signUpDto.password);
      const shouldCreateCompany = this.hasCompanyPayload(signUpDto);

      const user = await this.prisma.$transaction(async (tx) => {
        if (shouldCreateCompany) {
          if (!signUpDto.companyName || !signUpDto.companyCategory) {
            throw new SignupCompanyPayloadIncompleteException();
          }

          const company = await tx.company.create({
            data: {
              name: signUpDto.companyName,
              email: signUpDto.companyEmail,
              phoneNumber: signUpDto.companyPhoneNumber,
              description: signUpDto.description,
              location: signUpDto.location,
              address: signUpDto.address,
              companyCategory: signUpDto.companyCategory,
              logo: signUpDto.logo,
              primaryColor: signUpDto.primaryColor,
              secondaryColor: signUpDto.secondaryColor,
              isDeleted: false,
            },
          });

          const permissions = await tx.permission.findMany({
            where: {
              isDeleted: false,
            },
            select: {
              id: true,
            },
          });

          const adminRole = await tx.role.create({
            data: {
              name: 'admin',
              description: 'Default administrator role created during signup.',
              companyId: company.id,
              isDeleted: false,
              permissions: {
                create: permissions.map((permission) => ({
                  isDeleted: false,
                  permission: {
                    connect: { id: permission.id },
                  },
                })),
              },
            },
          });

          const createdUser = await tx.user.create({
            data: {
              firstName: signUpDto.firstName,
              lastName: signUpDto.lastName,
              email: signUpDto.email,
              password: passwordHash,
              companyId: company.id,
              isDeleted: false,
              roles: {
                create: {
                  isDeleted: false,
                  roleId: adminRole.id,
                },
              },
            },
            select: {
              id: true,
            },
          });

          await tx.company.update({
            where: { id: company.id },
            data: {
              ownerId: createdUser.id,
            },
          });

          return createdUser;
        }

        // Always assign RoleNotAssigned for users without a company
        const fallbackRole = await tx.role.findFirst({
          where: {
            name: 'NoCompanyRole',
            isDeleted: false,
          },
          select: {
            id: true,
          },
        });

        if (!fallbackRole) {
          throw new RoleNotAssignedNotFoundException();
        }

        return tx.user.create({
          data: {
            firstName: signUpDto.firstName,
            lastName: signUpDto.lastName,
            email: signUpDto.email,
            password: passwordHash,
            companyId: null,
            isDeleted: false,
            roles: {
              create: {
                isDeleted: false,
                roleId: fallbackRole.id,
              },
            },
          },
          select: {
            id: true,
          },
        });
      }, {
        timeout: 15000, // 15 seconds - increased from default 5 seconds
      });

      return this.buildAuthResponseFromUserId(user.id);
    } catch (error) {
      this.logger.error('Error signing up user', error instanceof Error ? error.stack : String(error));
      throw this.mapPersistenceError(error);
    }
  }

  async signin(signInDto: SignInDto) {
    const user = await this.usersRepository.findAuthByEmail(signInDto.email, { includeDeleted: false });

    if (!user || !this.verifyPassword(signInDto.password, user.password)) {
      throw new InvalidCredentialsException();
    }

    return this.buildAuthPayload(user);
  }

  async refreshTokens(refreshToken: string) {
    try {
      const decoded = this.verifyAndDecodeJwt(refreshToken);
      const email = decoded.email as string;
      const user = await this.usersRepository.findAuthByEmail(email, { includeDeleted: false });

      if (!user) {
        throw new InvalidRefreshTokenException();
      }

      return this.buildAuthPayload(user);
    } catch (error) {
      if (error instanceof InvalidRefreshTokenException) {
        throw error;
      }
      throw new InvalidRefreshTokenException();
    }
  }

  async googleSignin(_googleAuthDto: GoogleAuthDto) {
    throw new GoogleAuthNotImplementedException();
  }

  async googleSignup(_googleAuthDto: GoogleAuthDto) {
    throw new GoogleAuthNotImplementedException();
  }

  private async buildAuthResponseFromUserId(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        profilePic: true,
        phoneNumber: true,
        dateOfBirth: true,
        email: true,
        companyId: true,
        createdAt: true,
        updatedAt: true,
        isDeleted: true,
        deletedAt: true,
        company: {
          select: {
            id: true,
            name: true,
            description: true,
            companyCategory: true,
          },
        },
        roles: {
          where: {
            isDeleted: false,
            role: {
              isDeleted: false,
            },
          },
          select: {
            roleId: true,
            role: {
              select: {
                id: true,
                name: true,
                description: true,
                companyId: true,
                permissions: {
                  where: {
                    isDeleted: false,
                    permission: {
                      isDeleted: false,
                    },
                  },
                  select: {
                    permission: {
                      select: {
                        id: true,
                        slug: true,
                        name: true,
                        description: true,
                        module: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        password: true,
      },
    });

    if (!user) {
      throw new InvalidCredentialsException();
    }

    return this.buildAuthPayload(user);
  }

  private buildAuthPayload(user: AuthUserRecord) {
    const roleNames = user.roles.map((userRole) => userRole.role.name);
    const permissions = [...new Set(
      user.roles.flatMap((userRole) => userRole.role.permissions.map((rolePermission) => rolePermission.permission.slug)),
    )];

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      companyId: user.companyId,
      roleNames,
      permissions,
    };

    const accessTokenExpiresInSeconds = this.configService.getOrThrow<number>('users.accessTokenExpiresInSeconds');
    const refreshTokenExpiresInSeconds = this.configService.getOrThrow<number>('users.refreshTokenExpiresInSeconds');

    const accessToken = this.signJwt(tokenPayload, accessTokenExpiresInSeconds);
    const refreshToken = this.signJwt(tokenPayload, refreshTokenExpiresInSeconds);

    const { password: _password, ...safeUser } = user;
    return {
      tokens: {
        accessToken,
        refreshToken,
      },
      user: safeUser,
      claims: {
        userId: user.id,
        email: user.email,
        companyId: user.companyId,
        roleNames,
        permissions,
      },
    };
  }

  private hasCompanyPayload(signUpDto: SignUpDto): boolean {
    return Boolean(
      signUpDto.companyName ||
        signUpDto.companyEmail ||
        signUpDto.companyPhoneNumber ||
        signUpDto.description ||
        signUpDto.location ||
        signUpDto.address ||
        signUpDto.companyCategory,
    );
  }

  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, expectedHash] = storedHash.split(':');

    if (!salt || !expectedHash) {
      return false;
    }

    const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(actualHash, 'hex'));
  }

  private signJwt(payload: Record<string, unknown>, expiresInSeconds?: number): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresIn = expiresInSeconds ?? this.configService.getOrThrow<number>('users.jwtExpiresInSeconds');
    const body = {
      ...payload,
      iat: issuedAt,
      exp: issuedAt + expiresIn,
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(body));
    const secret = this.configService.getOrThrow<string>('users.jwtSecret');
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  private base64UrlEncode(value: string): string {
    return Buffer.from(value).toString('base64url');
  }

  private base64UrlDecode(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf-8');
  }

  private verifyAndDecodeJwt(token: string): Record<string, unknown> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid token format');
      }

      const [encodedHeader, encodedPayload, signature] = parts;
      const secret = this.configService.getOrThrow<string>('users.jwtSecret');

      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

      if (signature !== expectedSignature) {
        throw new Error('Invalid signature');
      }

      // Decode payload
      const payload = JSON.parse(this.base64UrlDecode(encodedPayload));

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        throw new Error('Token expired');
      }

      return payload;
    } catch (error) {
      throw new InvalidRefreshTokenException();
    }
  }

  private mapPersistenceError(error: unknown): unknown {
    if (error instanceof RoleNotAssignedNotFoundException || error instanceof SignupCompanyPayloadIncompleteException) {
      return error;
    }

    if (error instanceof UserEmailAlreadyExistsException || error instanceof UserRoleScopeInvalidException) {
      return error;
    }

    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }

    if (error.code === 'P2002') {
      return new UserEmailAlreadyExistsException('unknown');
    }

    if (error.code === 'P2022') {
      return new UsersSchemaOutdatedException();
    }

    return error;
  }
}
