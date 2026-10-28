import { Module } from '@nestjs/common';
import { EndCustomersController } from './end-customers.controller';
import { EndCustomersService } from './end-customers.service';

@Module({
  controllers: [EndCustomersController],
  providers: [EndCustomersService],
})
export class EndCustomersModule {}
