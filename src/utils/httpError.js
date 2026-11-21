/** Error with an HTTP status and a short machine-readable code for the UI. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
