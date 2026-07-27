import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "./auth/auth.guard.js";
import type { AuthPrincipal } from "./auth/auth.types.js";
import { Principal } from "./auth/principal.decorator.js";
import type { Command } from "./sessions.service.js";
import { SessionsService } from "./sessions.service.js";

@UseGuards(AuthGuard)
@Controller("v1")
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Post("sessions")
  create(
    @Principal() principal: AuthPrincipal,
    @Body() body: { organizationId: string; title: string; providerId?: string },
  ) {
    return this.sessions.create({
      principal,
      organizationId: body.organizationId,
      title: body.title,
      providerId: body.providerId ?? "simulator",
    });
  }

  @Get("organizations/:organizationId/sessions")
  list(
    @Param("organizationId") organizationId: string,
    @Principal() principal: AuthPrincipal,
  ) {
    return this.sessions.list(organizationId, principal);
  }

  @Get("branches/:branchId/state")
  state(@Param("branchId") branchId: string, @Principal() principal: AuthPrincipal) {
    return this.sessions.state(branchId, principal);
  }

  @Get("branches/:branchId/events")
  events(
    @Param("branchId") branchId: string,
    @Query("after", new ParseIntPipe({ optional: true })) after = 0,
    @Principal() principal: AuthPrincipal,
  ) {
    return this.sessions.events(branchId, after, principal);
  }

  @Get("branches/:branchId/artifacts")
  artifacts(
    @Param("branchId") branchId: string,
    @Principal() principal: AuthPrincipal,
  ) {
    return this.sessions.artifacts(branchId, principal);
  }

  @Get("branches/:branchId/collaborators")
  collaborators(
    @Param("branchId") branchId: string,
    @Principal() principal: AuthPrincipal,
  ) {
    return this.sessions.collaborators(branchId, principal);
  }

  @Post("branches/:branchId/commands")
  command(
    @Param("branchId") branchId: string,
    @Body() command: Command,
    @Principal() principal: AuthPrincipal,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) throw new TypeError("Idempotency-Key header is required");
    return this.sessions.command(branchId, command, principal, idempotencyKey);
  }
}
