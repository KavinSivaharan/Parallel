import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";
import { LiveGateway } from "../live.gateway.js";
import { ProviderOrchestratorService } from "../provider/provider-orchestrator.service.js";
import { OutboxRepository } from "./outbox.repository.js";

@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly workerId = `api-${ulid()}`;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastSuccessAt: string | null = null;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly live: LiveGateway,
    private readonly providers: ProviderOrchestratorService,
  ) {}

  onModuleInit(): void {
    this.schedule(0);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  status(): { running: boolean; lastSuccessAt: string | null } {
    return { running: this.running, lastSuccessAt: this.lastSuccessAt };
  }

  async dispatchOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      const messages = await this.outbox.claim(this.workerId);
      for (const message of messages) {
        try {
          this.live.publish([message.event]);
          await this.providers.handle(message.event);
          await this.outbox.delivered(message.eventId, this.workerId);
          this.lastSuccessAt = new Date().toISOString();
          delivered += 1;
        } catch (error) {
          this.logger.error(
            { eventId: message.eventId, attempts: message.attempts, error },
            "outbox dispatch failed",
          );
          await this.outbox.failed(message, this.workerId, error);
        }
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.dispatchOnce()
        .catch((error) => this.logger.error({ error }, "outbox polling failed"))
        .finally(() => this.schedule(250));
    }, delay);
    this.timer.unref();
  }
}

