import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  providers: [EventsGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
