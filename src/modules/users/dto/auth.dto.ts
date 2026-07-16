import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { UserCoreDto } from './create-user.dto';
import { IsValidEmail } from '../../../common/utils/validators.util';

export class SignUpDto extends UserCoreDto {
  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(120)
  companyName?: string;

  @ApiPropertyOptional({ example: 'contact@acme.com' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @MaxLength(120)
  companyEmail?: string;

  @ApiPropertyOptional({ example: '+15551234567' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(20)
  companyPhoneNumber?: string;

  @ApiPropertyOptional({ example: 'A workflow automation company.' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({ example: 'Cairo, Egypt' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(120)
  location?: string;

  @ApiPropertyOptional({ example: '123 Nile Street' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(255)
  address?: string;

  @ApiPropertyOptional({ example: 'Software' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(120)
  companyCategory?: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Company logo file (image). The file will be saved and the path stored in the database.',
  })
  @IsOptional()
  logo?: string;

  @ApiPropertyOptional({ example: '#FF6B6B' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(20)
  primaryColor?: string;

  @ApiPropertyOptional({ example: '#4ECDC4' })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(20)
  secondaryColor?: string;
}

export class SignInDto {
  @ApiProperty({ example: 'admin@Cultiv.com' })
  @IsValidEmail()
  @MaxLength(120)
  email: string;

  @ApiProperty({ example: 'Admin@1234' })
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  password: string;
}

export class GoogleAuthDto {
  @ApiProperty({ example: 'google-id-token' })
  @IsString()
  @MinLength(10)
  token: string;
}

export class AuthTokensDto {
  @ApiProperty({ description: 'Access token (expires in 60 minutes)' })
  accessToken: string;

  @ApiProperty({ description: 'Refresh token (expires in 3 days)' })
  refreshToken: string;
}

export class AuthResponseDto {
  @ApiProperty()
  tokens: AuthTokensDto;

  @ApiProperty()
  user: any;

  @ApiProperty()
  claims: any;
}
