import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class RolesPaginationDto extends PaginationDto {
  @ApiHideProperty()
  @IsUUID()
  @IsOptional()
  companyId?: string;
}
