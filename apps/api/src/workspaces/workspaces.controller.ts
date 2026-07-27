import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { Principal } from "../auth/principal.decorator.js";
import { WorkspacesService } from "./workspaces.service.js";

@UseGuards(AuthGuard)
@Controller("v1")
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Get("branches/:branchId/workspace")
  metadata(@Param("branchId") branchId: string, @Principal() principal: AuthPrincipal) {
    return this.workspaces.metadata(branchId, principal);
  }

  @Post("branches/:branchId/workspace/commands")
  command(
    @Param("branchId") branchId: string,
    @Principal() principal: AuthPrincipal,
    @Headers("idempotency-key") key: string,
    @Body() body: { expectedVersion: number; executable: string; args?: string[]; environment?: Record<string, string>; timeoutMs?: number },
  ) {
    return this.workspaces.command(branchId, principal, body.expectedVersion, key, body);
  }

  @Get("branches/:branchId/checkpoints")
  checkpoints(@Param("branchId") branchId: string, @Principal() principal: AuthPrincipal) {
    return this.workspaces.checkpoints(branchId, principal);
  }

  @Get("branches/:branchId/checkpoints/compare")
  compareCheckpoints(
    @Param("branchId") branchId: string,
    @Query("from") from: string,
    @Query("to") to: string,
    @Principal() principal: AuthPrincipal,
  ) {
    return this.workspaces.compareCheckpoints(branchId, from, to, principal);
  }

  @Post("branches/:branchId/checkpoints")
  checkpoint(
    @Param("branchId") branchId: string,
    @Principal() principal: AuthPrincipal,
    @Headers("idempotency-key") key: string,
    @Body() body: { expectedVersion: number; summary: string },
  ) {
    return this.workspaces.createCheckpoint(
      branchId,
      principal,
      body.expectedVersion,
      key,
      body.summary,
    );
  }

  @Post("branches/:branchId/checkpoints/:checkpointId/restore")
  restore(
    @Param("branchId") branchId: string,
    @Param("checkpointId") checkpointId: string,
    @Principal() principal: AuthPrincipal,
    @Headers("idempotency-key") key: string,
    @Body() body: { expectedVersion: number },
  ) {
    return this.workspaces.restoreCheckpoint(
      branchId,
      principal,
      body.expectedVersion,
      key,
      checkpointId,
    );
  }

  @Post("branches/:branchId/checkpoints/:checkpointId/forks")
  fork(
    @Param("branchId") branchId: string,
    @Param("checkpointId") checkpointId: string,
    @Principal() principal: AuthPrincipal,
    @Headers("idempotency-key") key: string,
  ) {
    return this.workspaces.fork(branchId, checkpointId, principal, key);
  }

  @Get("branches/:branchId/replay")
  replay(@Param("branchId") branchId: string, @Principal() principal: AuthPrincipal) {
    return this.workspaces.replay(branchId, principal);
  }

  @Get("artifacts/:artifactId/content")
  async artifact(
    @Param("artifactId") artifactId: string,
    @Principal() principal: AuthPrincipal,
    @Res() response: Response,
  ) {
    const artifact = await this.workspaces.artifactContent(artifactId, principal);
    response.type(artifact.mediaType);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${artifact.name.replaceAll('"', "")}"`,
    );
    response.send(artifact.content);
  }
}
