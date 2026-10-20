import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

/** Postgres text and jsonb cannot hold NUL; refuse it at the edge instead of failing deep inside a run. */
const NO_NUL = /^[^\u0000]*$/;
const noNul = () => Matches(NO_NUL, { message: '$property must not contain null characters' });
const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateConversationDto {
  /** Either customerId or email identifies who the conversation is bound to. */
  @ValidateIf((o: CreateConversationDto) => o.customerId !== undefined || o.email === undefined)
  @IsInt() @Min(1) @Max(2_147_483_647)
  customerId?: number;

  @ValidateIf((o: CreateConversationDto) => o.email !== undefined)
  @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(120) @noNul()
  title?: string;
}

export class SendMessageDto {
  @trim() @IsString() @IsNotEmpty() @Length(1, 2000) @noNul()
  content!: string;
}

export class ListApprovalsQuery {
  @IsOptional() @IsIn(['pending', 'approved', 'rejected', 'all'])
  status?: 'pending' | 'approved' | 'rejected' | 'all';
}

export class DecideApprovalDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsOptional() @IsString() @MaxLength(500) @noNul()
  note?: string;
}
