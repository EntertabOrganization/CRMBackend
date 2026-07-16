import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({
    description: 'The name of the company',
    example: 'Tech Solutions Inc.',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description: 'The contact email of the company',
    example: 'contact@techsolutions.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'The contact phone number of the company',
    example: '+1234567890',
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    description: 'A description of the company',
    example: 'A software company focused on workflow automation.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'The company location',
    example: 'Cairo, Egypt',
  })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({
    description: 'The physical address of the company',
    example: '123 Tech Lane, Silicon Valley, CA',
  })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiProperty({
    description: 'The category or industry of the company',
    example: 'Software Development',
  })
  @IsString()
  @IsNotEmpty()
  companyCategory: string;

  // Internal field - set from JWT token, not exposed in API
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Company logo file (image). The file will be saved and the path stored in the database.',
  })
  @IsOptional()
  logo?: string;

  @ApiPropertyOptional({
    description: 'The primary brand color for the company',
    example: '#FF6B6B',
  })
  @IsOptional()
  @IsString()
  primaryColor?: string;

  @ApiPropertyOptional({
    description: 'The secondary brand color for the company',
    example: '#4ECDC4',
  })
  @IsOptional()
  @IsString()
  secondaryColor?: string;
}
