import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Inject } from "@nestjs/common";
import type { EventEnvelope } from "@parallel/contracts";
import type { Server, Socket } from "socket.io";
import { DevelopmentIdentityService } from "./auth/development-identity.service.js";
import type { AuthPrincipal } from "./auth/auth.types.js";
import { OrganizationsService } from "./organizations/organizations.service.js";

@WebSocketGateway({ namespace: "/v1/live", cors: { origin: true, credentials: true } })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  constructor(
    @Inject(DevelopmentIdentityService)
    private readonly identity: DevelopmentIdentityService,
    @Inject(OrganizationsService)
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

  async handleDisconnect(socket: Socket): Promise<void> {
    const branches = socket.data.branches as string[] | undefined;
    await Promise.all((branches ?? []).map((branchId) => this.broadcastPresence(branchId)));
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
    const branches = new Set<string>((socket.data.branches as string[] | undefined) ?? []);
    branches.add(body.branchId);
    socket.data.branches = [...branches];
    await this.broadcastPresence(body.branchId);
    return { branchId: body.branchId };
  }

  publish(events: EventEnvelope[]): void {
    for (const event of events) {
      this.server.to(room(event.streamId)).emit("event.committed", event);
    }
  }

  private async broadcastPresence(branchId: string): Promise<void> {
    // Disconnect has not fully left its rooms until the next event-loop turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sockets = await this.server.in(room(branchId)).fetchSockets();
    const userIds = [
      ...new Set(
        sockets
          .map((socket) => (socket.data.principal as AuthPrincipal | undefined)?.userId)
          .filter((userId): userId is string => typeof userId === "string"),
      ),
    ];
    this.server.to(room(branchId)).emit("presence.changed", { branchId, userIds });
  }
}

function room(branchId: string): string {
  return `branch:${branchId}`;
}
