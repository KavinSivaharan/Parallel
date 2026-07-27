import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { EventEnvelope } from "@parallel/contracts";
import type { Server, Socket } from "socket.io";

@WebSocketGateway({ namespace: "/v1/live", cors: { origin: true, credentials: true } })
export class LiveGateway {
  @WebSocketServer()
  private server!: Server;

  @SubscribeMessage("branch.subscribe")
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { branchId: string },
  ): Promise<{ branchId: string }> {
    // Authentication and branch authorization will be enforced by the gateway guard.
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

