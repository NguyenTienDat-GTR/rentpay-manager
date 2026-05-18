import { Module } from '@nestjs/common';
import { BankAccountsController } from './bank-accounts.controller';
import { BankAccountsService } from './bank-accounts.service';

@Module({ controllers: [BankAccountsController], providers: [BankAccountsService], exports: [BankAccountsService] })
export class BankAccountsModule {}
