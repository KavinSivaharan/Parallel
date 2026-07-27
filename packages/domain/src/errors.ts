export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class ConcurrencyError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Stream ${streamId} expected version ${expected}, found ${actual}`);
    this.name = "ConcurrencyError";
  }
}

