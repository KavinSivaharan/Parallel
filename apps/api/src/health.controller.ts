import { Controller, Get, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import { OutboxDispatcherService } from "./outbox/outbox-dispatcher.service.js";
import { OutboxRepository } from "./outbox/outbox.repository.js";
import { PG_POOL } from "./persistence/database.constants.js";
import { ProviderOrchestratorService } from "./provider/provider-orchestrator.service.js";
import { RedisService } from "./realtime/redis.service.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OutboxRepository)
    private readonly outbox: OutboxRepository,
    @Inject(OutboxDispatcherService)
    private readonly dispatcher: OutboxDispatcherService,
    @Inject(ProviderOrchestratorService)
    private readonly providers: ProviderOrchestratorService,
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  @Get()
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness() {
    await this.pool.query("SELECT 1");
    return {
      status: "ready",
      postgres: "connected",
      redis: (await this.redis.ping()) === "PONG" ? "connected" : "degraded",
      outbox: {
        ...this.dispatcher.status(),
        states: await this.outbox.stats(),
      },
      providerOrchestration: this.providers.status(),
    };
  }
}
