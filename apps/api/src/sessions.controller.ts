import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from "@nestjs/common";
import type { Command } from "./sessions.service.js";
import { SessionsService } from "./sessions.service.js";

@Controller("v1")
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post("sessions")
  create(@Body() body: { ownerId: string; providerId?: string }) {
    return this.sessions.create(body.ownerId, body.providerId ?? "simulator");
  }

  @Get("branches/:branchId/state")
  state(@Param("branchId") branchId: string) {
    return this.sessions.state(branchId);
  }

  @Get("branches/:branchId/events")
  events(
    @Param("branchId") branchId: string,
    @Query("after", new ParseIntPipe({ optional: true })) after = 0,
  ) {
    return this.sessions.events(branchId, after);
  }

  @Post("branches/:branchId/commands")
  command(@Param("branchId") branchId: string, @Body() command: Command) {
    return this.sessions.command(branchId, command);
  }
}

