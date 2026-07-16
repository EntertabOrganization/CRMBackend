import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { UserCoreDto } from './create-user.dto';

export class UpdateUserDto extends PartialType(UserCoreDto) {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Profile picture file (image). The file will be saved and the path stored in the database.'
  })
  @IsOptional()
  profilePic?: string;

  @ApiPropertyOptional({
    description: 'The ID of the single role to assign to the user'
  })
  @IsOptional()
  roleId?: string;
}
