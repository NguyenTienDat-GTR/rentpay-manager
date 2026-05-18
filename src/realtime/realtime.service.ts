import { Injectable } from '@nestjs/common';
import { EventsGateway } from './events.gateway';

@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: EventsGateway) {}

  emitBusiness(businessId: string, event: string, payload: unknown) {
    this.gateway.server?.emit(`business:${businessId}:${event}`, payload);
  }
}
