import { Module } from '@nestjs/common';
import { ReportsController } from './report.controller';

@Module({
  controllers: [ReportsController],
})
export class ReportsModule {}
