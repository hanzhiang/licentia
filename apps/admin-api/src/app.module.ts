import { Module } from '@nestjs/common';
import { DbModule } from './db.module';
import { RedisModule } from './redis.module';
import { IamModule } from './iam/iam.module';
import { AuthModule } from './modules/auth/auth.module';
import { BatchModule } from './modules/batch/batch.module';
import { LicenseModule } from './modules/license/license.module';
import { ApiKeysModule } from './modules/apikey/apikey.module';
import { WebhooksModule } from './modules/webhook/webhook.module';
import { AuditModule } from './modules/audit/audit.module';
import { ActivationsModule } from './modules/activation/activation.module';
import { ReportsModule } from './modules/report/report.module';
import { EndCustomersModule } from './modules/endcustomer/end-customers.module';
import { PlatformModule } from './modules/platform/platform.module';
import { MemberModule } from './modules/member/member.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    DbModule,
    RedisModule,
    IamModule,
    AuthModule,
    BatchModule,
    LicenseModule,
    ApiKeysModule,
    WebhooksModule,
    AuditModule,
    ActivationsModule,
    ReportsModule,
    EndCustomersModule,
    PlatformModule,
    MemberModule,
    CatalogModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
