import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min, ValidateIf } from 'class-validator';

export class CreateConversationDto {
  /** Either customerId or email identifies who the conversation is bound to. */
  @ValidateIf((o: CreateConversationDto) => o.customerId !== undefined || o.email === undefined)
  @IsInt() @Min(1)
  customerId?: number;

  @ValidateIf((o: CreateConversationDto) => o.email !== undefined)
  @IsEmail()
  email?: string;

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
