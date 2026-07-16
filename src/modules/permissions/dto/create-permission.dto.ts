import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreatePermissionDto {
  @ApiProperty({ example: 'company_create', description: 'The unique slug identifier for the permission' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, {
    message: 'slug must be lowercase and use underscores only.',
  })
  slug: string;

  @ApiProperty({ example: 'CREATE Company', description: 'The human readable name of the permission' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'Allows CREATE operations on Company', description: 'Detailed description of what the permission allows', required: false })
  @Transform(trimString)
  @IsString()
  @IsOptional()
  @MaxLength(255)
  description?: string;

  @ApiProperty({ example: 'Company', description: 'The module this permission belongs to' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  module: string;
}
