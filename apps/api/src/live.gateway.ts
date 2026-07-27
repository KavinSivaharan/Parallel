import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from "@nestjs/websockets";
import type { EventEnvelope } from "@parallel/contracts";
import type { Server, Socket } from "socket.io";
import { DevelopmentIdentityService } from "./auth/development-identity.service.js";
import type { AuthPrincipal } from "./auth/auth.types.js";
import { OrganizationsService } from "./organizations/organizations.service.js";

@WebSocketGateway({ namespace: "/v1/live", cors: { origin: true, credentials: true } })
export class LiveGateway implements OnGatewayConnection {
  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly identity: DevelopmentIdentityService,
    private readonly organizations: OrganizationsService,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = socket.handshake.auth.token;
      if (typeof token !== "string") throw new Error("Missing token");
      socket.data.principal = await this.identity.verify(token);
    } catch {
      socket.disconnect(true);
    }
  }

  @SubscribeMessage("branch.subscribe")
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { branchId: string },
  ): Promise<{ branchId: string }> {
    const principal = socket.data.principal as AuthPrincipal | undefined;
    if (!principal) {
      socket.disconnect(true);
      throw new Error("Unauthenticated socket");
    }
    await this.organizations.requireSessionAccess(body.branchId, principal.userId);
    await socket.join(room(body.branchId));
    return { branchId: body.branchId };
  }

  publish(events: EventEnvelope[]): void {
    for (const event of events) {
      this.server.to(room(event.streamId)).emit("event.committed", event);
    }
  }
}

function room(branchId: string): string {
  return `branch:${branchId}`;
}
