import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import { RedisIoAdapter } from "./realtime/redis-io.adapter.js";
import { RedisService } from "./realtime/redis.service.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });
  const realtimeAdapter = new RedisIoAdapter(app, app.get(RedisService));
  await realtimeAdapter.connect();
  app.useWebSocketAdapter(realtimeAdapter);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(Number(process.env.PORT ?? 4000));
}

void bootstrap();
