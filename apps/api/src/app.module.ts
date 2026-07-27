import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { DevelopmentIdentityService } from "./auth/development-identity.service.js";
import { HealthController } from "./health.controller.js";
import { LiveGateway } from "./live.gateway.js";
import { OrganizationsController } from "./organizations/organizations.controller.js";
import { OrganizationsService } from "./organizations/organizations.service.js";
import { OutboxDispatcherService } from "./outbox/outbox-dispatcher.service.js";
import { OutboxRepository } from "./outbox/outbox.repository.js";
import { PG_POOL } from "./persistence/database.constants.js";
import { PostgresEventStore } from "./persistence/postgres-event-store.js";
import { SessionsController } from "./sessions.controller.js";
import { SessionsService } from "./sessions.service.js";
import { ProviderOrchestratorService } from "./provider/provider-orchestrator.service.js";
import { ProvidersController } from "./provider/providers.controller.js";
import { RedisService } from "./realtime/redis.service.js";
import { WorkspaceManager } from "@parallel/workspace-runtime";
import { resolve } from "node:path";
import { WorkspacesController } from "./workspaces/workspaces.controller.js";
import { WorkspacesService } from "./workspaces/workspaces.service.js";

@Module({
  controllers: [
    AuthController,
    HealthController,
    OrganizationsController,
    SessionsController,
    WorkspacesController,
    ProvidersController,
  ],
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          connectionString:
            process.env.DATABASE_URL ??
            "postgresql://parallel:parallel@localhost:5432/parallel",
        }),
    },
    PostgresEventStore,
    DevelopmentIdentityService,
    AuthGuard,
    OrganizationsService,
    OutboxRepository,
    ProviderOrchestratorService,
    OutboxDispatcherService,
    RedisService,
    WorkspacesService,
    {
      provide: WorkspaceManager,
      useFactory: () =>
        new WorkspaceManager(
          resolve(process.env.WORKSPACE_ROOT ?? ".parallel/workspaces"),
        ),
    },
    SessionsService,
    LiveGateway,
  ],
})
export class AppModule {}
