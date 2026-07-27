import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { DevelopmentIdentityService } from "./development-identity.service.js";

export interface AuthenticatedRequest extends Request {
  principal: Awaited<ReturnType<DevelopmentIdentityService["verify"]>>;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly identity: DevelopmentIdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const value = request.headers.authorization;
    if (!value?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Bearer access token required");
    }
    request.principal = await this.identity.verify(value.slice("Bearer ".length));
    return true;
  }
}

