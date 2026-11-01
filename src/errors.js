export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const invalid = () => new ApiError(400, 'INVALID_REQUEST', 'Check the checkout details and try again.');
export const missingOrder = () => new ApiError(404, 'ORDER_NOT_FOUND', 'This receipt is unavailable.');
