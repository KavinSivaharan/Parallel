import type { EventEnvelope, PendingEvent } from "@parallel/contracts";

export interface EventStream {
  streamId: string;
  version: number;
  events: EventEnvelope[];
}

export interface AppendResult {
  nextVersion: number;
  events: EventEnvelope[];
}

export interface EventStore {
  load(streamId: string, afterSequence?: number): Promise<EventStream>;
  append(
    streamId: string,
    expectedVersion: number,
    events: PendingEvent[],
  ): Promise<AppendResult>;
}

