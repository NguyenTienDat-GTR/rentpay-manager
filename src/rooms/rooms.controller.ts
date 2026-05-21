import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RoomStatus } from '@prisma/client';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { RoomsService } from './rooms.service';

@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.rooms.list(user, query);
  }

  @Get('check-code')
  @Retryable()
  checkCode(@CurrentUser() user: AuthUser, @Query('roomCode') roomCode: string, @Query('roomAreaId') roomAreaId: string, @Query('exceptId') exceptId?: string) {
    return this.rooms.checkRoomCode(user, roomCode, roomAreaId, exceptId);
  }

  @Get(':id')
  @Retryable()
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rooms.get('room', user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.rooms.createRoom(user, body);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.rooms.updateRoom(user, id, body);
  }

  @Patch(':id/status')
  status(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('status') status: RoomStatus) {
    return this.rooms.changeStatus(user, id, status);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rooms.removeRoom(user, id);
  }
}
