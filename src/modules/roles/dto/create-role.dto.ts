import { Transform } from 'class-transformer';
import { ApiHideProperty, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRoleDto {
  @ApiProperty({ example: 'Operations Manager', description: 'The role name' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'Manages operational workflows and approvals.', description: 'Optional role description' })
  @Transform(trimString)
  @IsString()
  @IsOptional()
  @MaxLength(255)
  description?: string;

  @ApiHideProperty()
  @IsUUID()
  @IsOptional()
  companyId?: string;

  @ApiProperty({
    example: ['0f9a7fb7-c3fb-483b-a8fd-1146a1848b14', 'c5898a44-50d7-4814-aa55-ac2af4ef9750'],
    description: 'Permission IDs linked to the role',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  permissions: string[];
}
