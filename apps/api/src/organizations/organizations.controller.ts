import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { Principal } from "../auth/principal.decorator.js";
import { OrganizationsService } from "./organizations.service.js";

@UseGuards(AuthGuard)
@Controller("v1/organizations")
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  list(@Principal() principal: AuthPrincipal) {
    return this.organizations.list(principal.userId);
  }

  @Post()
  create(
    @Principal() principal: AuthPrincipal,
    @Body() body: { name: string; slug: string },
  ) {
    return this.organizations.create(principal, body.name, body.slug);
  }

  @Post("join")
  join(@Principal() principal: AuthPrincipal, @Body() body: { slug: string }) {
    return this.organizations.join(principal.userId, body.slug);
  }
}

