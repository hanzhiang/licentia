import { Global, Module } from '@nestjs/common';
import { LicenseSigner, makeSignerProviders } from '@lp/signer';
import { getConfig } from '@lp/config';

export const SIGNER = Symbol('SIGNER');

@Global()
@Module({
  providers: [
    {
      provide: SIGNER,
      useFactory: () => {
        const cfg = getConfig();
        return new LicenseSigner(
          makeSignerProviders({
            provider: cfg.SIGNER_PROVIDER,
            kid: cfg.SIGNER_ACTIVE_KID,
            localSeed: cfg.SIGNER_LOCAL_SEED,
            vault: { addr: cfg.VAULT_ADDR, token: cfg.VAULT_TOKEN, keyName: cfg.VAULT_TRANSIT_KEY },
            previousKid: cfg.SIGNER_PREVIOUS_KID,
            previousLocalSeed: cfg.SIGNER_LOCAL_SEED_PREVIOUS,
            previousVaultKeyName: cfg.VAULT_TRANSIT_KEY_PREVIOUS,
          }),
        );
      },
    },
  ],
  exports: [SIGNER],
})
export class SignerModule {}
