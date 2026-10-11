import { IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';

export class CreateConversationDto {
  @IsInt() @Min(1)
  customerId!: number;

  @IsOptional() @IsString() @MaxLength(120)
  title?: string;
}

export class SendMessageDto {
  @IsString() @Length(1, 2000)
  content!: string;
}

export class ListApprovalsQuery {
  @IsOptional() @IsIn(['pending', 'approved', 'rejected', 'all'])
  status?: 'pending' | 'approved' | 'rejected' | 'all';
}

export class DecideApprovalDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}
