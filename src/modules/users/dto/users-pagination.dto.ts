import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class UsersPaginationDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Optional company scope. Omit to work with unassigned users.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  companyId?: string;
}
