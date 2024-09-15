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
import { openMint } from '../mint/ft.open-minter';
interface AlongCommandOptions extends BoardcastCommandOptions {
    id?: string;
    action: string;
    nums?: number;
    times?: number;
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

            else if (options.action === 'info') {
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

                const count = await getTokenMinterCount(
                    this.configService,
                    token.tokenId,
                );

                console.log('count', count);
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

            else if (options.action === 'mint') {
                if (!options.id) {
                    console.error('expect a ID option');
                    return;
                }

                const address = this.walletService.getAddress();
                const feeRate = await this.getFeeRate();
                let feeUtxos = await this.getFeeUTXOs(address);
                if (feeUtxos.length === 0) {
                    console.warn('Insufficient satoshis balance!');
                    return;
                }

                const token = await findTokenMetadataById(
                    this.configService,
                    options.id,
                );

                const times = options.times || 1;
                const feeUtxosArr = [];

                const nums = options.nums || 1;
                let perTimes = Math.floor(feeUtxos.length / times);
                perTimes = perTimes > 0 ? perTimes : 1;
                perTimes = perTimes > nums ? perTimes : nums;
                for (let i = 0; i < times; i++) {
                    const utxos = feeUtxos.slice(i * perTimes, (i + 1) * perTimes);
                    feeUtxosArr.push(utxos);
                }

                for (let i = 0; i < times; i++) {
                    const utxos = feeUtxosArr[i];

                    const count = await getTokenMinterCount(
                        this.configService,
                        token.tokenId,
                    );

                    if (count == 0) {
                        console.error('No available minter UTXO found!');
                        return;
                    }

                    const offset = getRandomInt(count - 1);
                    const minter = await getTokenMinter(
                        this.configService,
                        this.walletService,
                        token,
                        offset,
                    );

                    if (minter == null) {
                        return;
                    }

                    if (isOpenMinter(token.info.minterMd5)) {
                        const minterState = minter.state.data;
                        const scaledInfo = scaleConfig(token.info as OpenMinterTokenInfo);
                        const limit = scaledInfo.limit;

                        if (minter.state.data.remainingSupply < limit) {
                            console.warn(
                                `small limit of ${unScaleByDecimals(limit, token.info.decimals)} in the minter UTXO!`,
                            );
                            log(`retry to mint token [${token.info.symbol}] ...`);
                            return;
                        }

                        let amount: bigint | undefined;
                        if (!minter.state.data.isPremined && scaledInfo.premine > 0n) {
                            amount = scaledInfo.premine;
                        } else {
                            amount = amount || limit;
                            amount =
                                amount > minter.state.data.remainingSupply
                                    ? minter.state.data.remainingSupply
                                    : amount;
                        }

                        const mintTxIdOrErr = await openMint(
                            this.configService,
                            this.walletService,
                            this.spendService,
                            feeRate,
                            feeUtxos,
                            token,
                            2,
                            minter,
                            amount,
                        );

                        if (mintTxIdOrErr instanceof Error) {
                            if (needRetry(mintTxIdOrErr)) {
                                // throw these error, so the caller can handle it.
                                log(`retry to mint token [${token.info.symbol}] ...`);
                                await sleep(6);
                                return;
                            } else {
                                logerror(
                                    `mint token [${token.info.symbol}] failed`,
                                    mintTxIdOrErr,
                                );
                                return;
                            }
                        }

                        console.log(
                            `Minting ${unScaleByDecimals(amount, token.info.decimals)} ${token.info.symbol} tokens in txid: ${mintTxIdOrErr} ...`,
                        );
                    } else {
                        throw new Error('unkown minter!');
                    }
                }
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

    @Option({
        flags: '-n, --nums [nums]',
        description: 'mint token use nums uxtos',
    })
    parseNums(val: string): number {
        return parseInt(val);
    }

    @Option({
        flags: '-t, --times [times]',
        description: 'mint token use times',
    })
    parseTimes(val: string): number {
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
