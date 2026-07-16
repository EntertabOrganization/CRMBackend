import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

const parseFilters = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const parsedValue = JSON.parse(value);
    return parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
      ? parsedValue
      : undefined;
  } catch {
    return undefined;
  }
};

const parseSoftDeleteFilter = ({ value }: { value: unknown }): 'true' | 'false' | 'all' | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.toLowerCase();
  if (normalizedValue === 'true' || normalizedValue === 'false' || normalizedValue === 'all') {
    return normalizedValue as 'true' | 'false' | 'all';
  }

  return undefined;
};

export class PaginationDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 150 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(150)
  @IsOptional()
  limit = 10;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortOrder: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({
    description: 'JSON string filters, for example {"status":"ACTIVE"}',
    type: String,
  })
  @Transform(parseFilters)
  @IsObject()
  @IsOptional()
  filters?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: ['true', 'false', 'all'], default: 'false' })
  @Transform(parseSoftDeleteFilter)
  @IsIn(['true', 'false', 'all'])
  @IsOptional()
  is_deleted: 'true' | 'false' | 'all' = 'false';

  @ApiPropertyOptional({ type: String, description: 'UUID of the pipeline' })
  @IsUUID()
  @IsOptional()
  pipelineId?: string;
}
