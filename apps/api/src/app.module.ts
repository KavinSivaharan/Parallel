import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { HealthController } from "./health.controller.js";
import { LiveGateway } from "./live.gateway.js";
import { PG_POOL } from "./persistence/database.constants.js";
import { PostgresEventStore } from "./persistence/postgres-event-store.js";
import { SessionsController } from "./sessions.controller.js";
import { SessionsService } from "./sessions.service.js";

@Module({
  controllers: [HealthController, SessionsController],
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
    SessionsService,
    LiveGateway,
  ],
})
export class AppModule {}
