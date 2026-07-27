import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import { ProviderOrchestratorService } from "./provider-orchestrator.service.js";

@UseGuards(AuthGuard)
@Controller("v1/providers")
export class ProvidersController {
  constructor(
    @Inject(ProviderOrchestratorService)
    private readonly providers: ProviderOrchestratorService,
  ) {}

  @Get()
  catalog() {
    return this.providers.providerCatalog();
  }
}
