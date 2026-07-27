import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createClient, type RedisClientType } from "redis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly publisher: RedisClientType;
  readonly subscriber: RedisClientType;

  constructor() {
    this.publisher = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
    this.subscriber = this.publisher.duplicate();
  }

  async connect(): Promise<void> {
    if (!this.publisher.isOpen) await this.publisher.connect();
    if (!this.subscriber.isOpen) await this.subscriber.connect();
  }

  async ping(): Promise<string> {
    await this.connect();
    return this.publisher.ping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber.isOpen) await this.subscriber.quit();
    if (this.publisher.isOpen) await this.publisher.quit();
  }
}

