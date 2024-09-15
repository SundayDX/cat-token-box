import { Command, Option } from 'nest-commander';
import {
  getUtxos,
  OpenMinterTokenInfo,
  getTokenMinter,
  logerror,
  getTokenMinterCount,
  isOpenMinter,
  sleep,
  needRetry,
  unScaleByDecimals,
  getTokens,
  btc,
  TokenMetadata,
} from 'src/common';
import { ConfigService, SpendService, WalletService } from 'src/providers';
import { Inject } from '@nestjs/common';
import { log } from 'console';
import { findTokenMetadataById, scaleConfig } from 'src/token';
import Decimal from 'decimal.js';
import {
  BoardcastCommand,
  BoardcastCommandOptions,
} from '../boardcast.command';
import { broadcastMergeTokenTxs, mergeTokens } from '../send/merge';
import { calcTotalAmount, sendToken } from '../send/ft';
import { pickLargeFeeUtxo } from '../send/pick';
interface AlongCommandOptions extends BoardcastCommandOptions {
  id?: string;
  action: string;
  split?: number;
}

function getRandomInt(max: number) {
  return Math.floor(Math.random() * max);
}

@Command({
  name: 'along',
  description: 'along commands',
})
export class AlongCommand extends BoardcastCommand {
  constructor(
    @Inject() private readonly spendService: SpendService,
    @Inject() protected readonly walletService: WalletService,
    @Inject() protected readonly configService: ConfigService,
  ) {
    super(spendService, walletService, configService);
  }

  async cat_cli_run(
    passedParams: string[],
    options?: AlongCommandOptions,
  ): Promise<void> {
    try {
        if (options.action === 'listuxto') {
            const address = this.walletService.getAddress();
            const utxos = await this.getFeeUTXOs(address);
            console.log(utxos);
        }

        else if (options.action === 'limitcheck') {
            if (!options.id) {
                console.error('expect a ID option');
                return;
            }

            const address = this.walletService.getAddress();
            const token = await findTokenMetadataById(
                this.configService,
                options.id,
            );

            if (!token) {
                console.error(`No token found for tokenId: ${options.id}`);
                return;
            }

            const scaledInfo = scaleConfig(token.info as OpenMinterTokenInfo);
            console.log('token info', scaledInfo);
        }

        else if (options.action === 'split') {
            if (!options.split) {
                console.error('expect a split option');
                return;
            }

            const address = this.walletService.getAddress();
            let utxos = await this.getFeeUTXOs(address);
            utxos = utxos.filter((utxo) => {
                return this.spendService.isUnspent(utxo);
              });
            console.log(utxos);
        }

    } catch (error) {
      logerror('mint failed!', error);
    }
  }

  @Option({
    flags: '-a, --action [action]',
    description: 'action command',
  })
  parseAction(val: string): string {
    return val;
  }

  @Option({
    flags: '-i, --id [tokenId]',
    description: 'ID of the token',
  })
  parseId(val: string): string {
    return val;
  }

  @Option({
    flags: '-s, --split [split]',
    description: 'split the fee to multiple outputs',
  })
  parseSplit(val: string): number {
    return parseInt(val);
  }

  async getFeeUTXOs(address: btc.Address) {
    let feeUtxos = await getUtxos(
      this.configService,
      this.walletService,
      address,
    );

    feeUtxos = feeUtxos.filter((utxo) => {
      return this.spendService.isUnspent(utxo);
    });

    if (feeUtxos.length === 0) {
      console.warn('Insufficient satoshis balance!');
      return [];
    }
    return feeUtxos;
  }
}
