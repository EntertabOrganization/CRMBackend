import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsValidEmail, IsValidPhoneNumber, IsValidString } from '../../../common/utils/validators.util';

const trimString = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export class UserCoreDto {
  @ApiProperty({ example: 'Jane' })
  @Transform(trimString)
  @Type(() => String)
  @IsValidString()
  @IsString()
  @MaxLength(80)
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @Transform(trimString)
  @Type(() => String)
  @IsValidString()
  @IsString()
  @MaxLength(80)
  lastName: string;

  @ApiProperty({ example: 'jane@example.com' })
  @Transform(trimString)
  @Type(() => String)
  @IsValidEmail()
  @MaxLength(120)
  email: string;

  @ApiProperty({ example: 'SecurePass123' })
  @Transform(trimString)
  @Type(() => String)
  @IsValidString()
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  password: string;

  @ApiPropertyOptional({ example: '+201234567890' })
  @Transform(trimString)
  @Type(() => String)
  @IsOptional()
  @IsValidPhoneNumber()
  @MaxLength(20)
  phoneNumber?: string;

  /**
   * Accepted as a plain optional string (e.g. '1995-05-14').
   * Conversion to Date happens in the service layer.
   * No date validator here to avoid issues with multipart/form-data empty strings.
   */
  @ApiPropertyOptional({ example: '1995-05-14' })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Profile picture file (image). The file will be saved and the path stored in the database.',
  })
  @IsOptional()
  profilePic?: string;
}

export class CreateUserDto extends UserCoreDto {
  @ApiPropertyOptional({
    example: '9a678ec9-48f4-4aa4-ae77-b1d6dc7838ec',
    description: 'id of the one role only',
    type: String,
  })
  @IsOptional()
  @IsUUID()
  roleId?: string;
}
