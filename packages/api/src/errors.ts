/** An error with an HTTP status, turned into the standard error body by the error handler. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly issues: readonly string[] | undefined;

  constructor(statusCode: number, code: string, message: string, issues?: readonly string[]) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.issues = issues;
  }

  toJSON(): { error: string; message: string; issues?: readonly string[] } {
    return this.issues === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, issues: this.issues };
  }
}

export const notFound = (what: string, id: string) =>
  new ApiError(404, 'not_found', `${what} "${id}" does not exist`);
