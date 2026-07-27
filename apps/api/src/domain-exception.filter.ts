import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import { ConcurrencyError, DomainError } from "@parallel/domain";
import type { Response } from "express";

@Catch(DomainError, ConcurrencyError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError | ConcurrencyError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ConcurrencyError) {
      response.status(HttpStatus.CONFLICT).json({
        code: "stream_version_conflict",
        message: exception.message,
        currentVersion: exception.actual,
      });
      return;
    }
    response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
      code: exception.code,
      message: exception.message,
    });
  }
}

