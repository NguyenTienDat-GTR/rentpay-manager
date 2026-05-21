import { Module } from '@nestjs/common';
import { RoomAreasController } from './room-areas.controller';
import { RoomAreasService } from './room-areas.service';

@Module({ controllers: [RoomAreasController], providers: [RoomAreasService], exports: [RoomAreasService] })
export class RoomAreasModule {}
