// Domain errors. Mapped to tRPC codes in server/trpc/init.ts.

export interface Problem {
  field?: string;
  code: string;
  message: string;
}

export class CoreError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
  }
}
export class ValidationError extends CoreError {
  constructor(readonly problems: Problem[]) {
    super(problems.map((p) => p.message).join('; '), { problems });
  }
}
export class AdmissionRejected extends CoreError {
  constructor(readonly problems: Problem[]) {
    super('The run was not admitted', { problems });
  }
}
export class NotFound extends CoreError {}
export class Forbidden extends CoreError {}
export class Conflict extends CoreError {}
export class UpstreamUnavailable extends CoreError {}
