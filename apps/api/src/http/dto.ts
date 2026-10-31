import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';

/** Postgres text and jsonb cannot hold NUL; refuse it at the edge instead of failing deep inside a run. */
const NO_NUL = /^[^\u0000]*$/;
const noNul = () => Matches(NO_NUL, { message: '$property must not contain null characters' });
const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateConversationDto {
  /** Login off: either customerId or email identifies who the conversation is bound to. Login on: neither is accepted. */
  @IsOptional() @IsInt() @Min(1) @Max(2_147_483_647)
  customerId?: number;

  @IsOptional() @IsEmail()
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

export class ListApprovalEventsQuery {
  @IsOptional() @IsUUID()
  conversationId?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  /** Event id to page from: returns events older than it. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  before?: number;
}

/** Passwords are only length-checked here (the hashing code owns the minimum) and never appear in a validation message. */
const passwordField = () => (target: object, key: string) => {
  IsString({ message: `${key} must be a string` })(target, key);
  MaxLength(200, { message: `${key} must be at most 200 characters` })(target, key);
};

export class LoginDto {
  @trim() @IsEmail() @MaxLength(254)
  email!: string;

  @passwordField()
  password!: string;
}

export class ChangePasswordDto {
  @passwordField()
  current!: string;

  @passwordField()
  next!: string;
}

export class CreateReviewerDto {
  @trim() @IsEmail() @MaxLength(254)
  email!: string;

  @trim() @IsString() @Length(1, 100) @noNul()
  name!: string;

  @IsIn(['admin', 'reviewer'])
  role!: 'admin' | 'reviewer';

  @passwordField()
  password!: string;
}

export class UpdateReviewerDto {
  @IsOptional() @trim() @IsString() @Length(1, 100) @noNul()
  name?: string;

  @IsOptional() @IsIn(['admin', 'reviewer'])
  role?: 'admin' | 'reviewer';

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @passwordField()
  password?: string;
}

export class RequestLinkDto {
  @trim() @IsEmail() @MaxLength(254)
  email!: string;
}

/** Only the type is checked here: every other problem with a token (empty, huge, unknown) is the same 401 from the service. */
export class VerifyLinkDto {
  @IsString()
  token!: string;
}
