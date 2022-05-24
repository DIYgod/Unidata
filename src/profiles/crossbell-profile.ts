import Main from '../index';
import Base from './base';
import { Indexer, Contract, Network } from 'crossbell.js';
import { ProfilesOptions, ProfileSetOptions, ProfileInput } from './index';
import { Web3Storage } from 'web3.storage';
import axios from 'axios';

class CrossbellProfile extends Base {
    indexer: Indexer;
    contract: Contract;
    contractSet: Contract;

    constructor(main: Main) {
        super(main);

        Network.setIpfsGateway(this.main.options.ipfsGateway!);
    }

    async get(options: ProfilesOptions) {
        options = Object.assign(
            {
                platform: 'Ethereum',
            },
            options,
        );

        let result;
        switch (options.platform) {
            case 'Ethereum': {
                if (!this.indexer) {
                    this.indexer = new Indexer();
                }
                const res = await this.indexer.getProfiles(options.identity, {
                    lastIdentifier: options.cursor,
                    limit: options.limit,
                });

                const list = res.list.map((item: any) => {
                    const profile: Profile = Object.assign(
                        {
                            username: item.handle,
                            source: 'Crossbell Profile',

                            metadata: {
                                network: 'Crossbell',
                                proof: item.token_id,

                                primary: item.primary,
                                block_number: item.block_number,
                            },
                        },
                        {
                            ...(item.metadata?.name && { name: item.metadata.name }),
                            ...(item.metadata?.bio && { bio: item.metadata.bio }),
                            ...(item.metadata?.banners && { banners: item.metadata.banners }),
                            ...(item.metadata?.avatars && { avatars: item.metadata.avatars }),
                            ...(item.metadata?.websites && { websites: item.metadata.websites }),
                            ...(item.metadata?.connected_accounts && {
                                connected_accounts: item.metadata.connected_accounts,
                            }),
                        },
                    );

                    return profile;
                });

                result = {
                    total: res.total,
                    ...(options.limit &&
                        list.length >= options.limit && { cursor: list[list.length - 1].metadata?.token_id }),

                    list,
                };
                break;
            }
            case 'Crossbell': {
                if (!this.contract) {
                    this.contract = new Contract();
                    await this.contract.connect();
                }
                const info = (await this.contract.getProfileByHandle(options.identity)).data;
                if (info.profileId === '0') {
                    return {
                        total: 0,
                        list: [],
                    };
                }
                let meta: any = info.metadata;
                if (!meta && info.uri) {
                    meta = (await axios.get(this.main.utils.replaceIPFS(info.uri))).data;
                }
                const profile: Profile = Object.assign(
                    {
                        name: info.handle,
                        source: 'Crossbell Profile',

                        metadata: {
                            network: 'Crossbell',
                            proof: info.profileId,

                            handler: info.handle,
                            uri: info.uri,
                        },
                    },
                    meta,
                );

                result = {
                    total: 1,
                    list: [profile],
                };
                break;
            }
            default:
                throw new Error(`Unsupported platform: ${options.platform}`);
        }

        result.list = result.list.map((profile: Profile) => {
            if (profile.avatars) {
                profile.avatars = this.main.utils.replaceIPFSs(profile.avatars);
            }
            if (profile.banners) {
                profile.banners = this.main.utils.replaceIPFSs(profile.banners);
            }

            // Crossbell specification compatibility
            if (profile.connected_accounts) {
                profile.connected_accounts = profile.connected_accounts.map((account: any) => {
                    if (typeof account === 'string') {
                        const match = account.match(/:\/\/account:(.*)@(.*)/);
                        if (match) {
                            account = {
                                identity: match[1],
                                platform: match[2],
                            };
                        } else {
                            account = {
                                identity: account,
                            };
                        }
                    }
                    const platform = account.platform.toLowerCase();
                    if (account.identity && account.platform && this.accountsMap[platform]) {
                        const acc: Required<Profile>['connected_accounts'][number] = {
                            identity: account.identity,
                            platform: this.accountsMap[platform].platform,
                        };
                        if (this.accountsMap[platform].url) {
                            acc.url = this.accountsMap[platform].url?.replace('$$id', account.identity);
                        }
                        return acc;
                    } else {
                        return {
                            identity: account.identity,
                            platform: account.platform,
                        };
                    }
                });
            }

            return profile;
        });

        return result;
    }

    async set(options: ProfileSetOptions, input: ProfileInput) {
        options = Object.assign(
            {
                platform: 'Ethereum',
                action: 'update',
            },
            options,
        );

        if (!this.contractSet) {
            this.contractSet = new Contract(this.main.options.ethereumProvider);
            await this.contractSet.connect();
        }

        switch (options.action) {
            case 'update': {
                let profile: any = {};

                switch (options.platform) {
                    case 'Ethereum':
                        {
                            if (!this.indexer) {
                                this.indexer = new Indexer();
                            }
                            profile = (
                                await this.indexer.getProfiles(options.identity, {
                                    primary: true,
                                })
                            ).list[0];
                        }
                        break;
                    case 'Crossbell':
                        {
                            const info = (await this.contractSet.getProfileByHandle(options.identity)).data;
                            if (info.profileId === '0') {
                                return {
                                    code: 1,
                                    message: 'Profile not found',
                                };
                            }
                            let meta;
                            if (info.uri) {
                                meta = (await axios.get(this.main.utils.replaceIPFS(info.uri))).data;
                            }
                            profile = {
                                token_id: info.profileId,
                                handle: info.handle,
                                metadata: meta,
                            };
                        }
                        break;
                    default:
                        throw new Error(`Unsupported platform: ${options.platform}`);
                }

                // createProfile
                if (!profile) {
                    return {
                        code: 1,
                        message: 'Profile not found',
                    };
                }

                const proof = profile.token_id;

                // setHandle
                if (input.username && input.username !== profile.handle) {
                    await this.contractSet.setHandle(proof, input.username);
                }

                // setProfileUri
                if (Object.keys(input).filter((key) => key !== 'username').length) {
                    const username = input.username || options.identity;
                    delete input.username;

                    // Crossbell specification compatibility
                    if (input.connected_accounts) {
                        input.connected_accounts = input.connected_accounts.map((account: any) => {
                            if (account.identity && account.platform) {
                                return `csb://account:${account.identity}@${account.platform.toLowerCase()}`;
                            } else {
                                return account;
                            }
                        });
                    }

                    const result = Object.assign({}, profile.metadata, input);
                    const blob = new Blob([JSON.stringify(result)], {
                        type: 'application/json',
                    });
                    const file = new File([blob], `${username}.json`);
                    const web3Storage = new Web3Storage({
                        token: this.main.options.web3StorageAPIToken!,
                    });
                    const cid = await web3Storage.put([file], {
                        name: file.name,
                        maxRetries: 3,
                        wrapWithDirectory: false,
                    });
                    await this.contractSet.setProfileUri(proof, `ipfs://${cid}`);

                    return {
                        code: 0,
                        message: 'Success',
                    };
                } else {
                    return {
                        code: 0,
                        message: 'Success',
                    };
                }
            }
            case 'add': {
                switch (options.platform) {
                    case 'Ethereum': {
                        const web3Storage = new Web3Storage({
                            token: this.main.options.web3StorageAPIToken!,
                        });
                        const username = input.username || options.identity;
                        delete input.username;
                        const result = input;
                        const blob = new Blob([JSON.stringify(result)], {
                            type: 'application/json',
                        });
                        const file = new File([blob], `${username}.json`);
                        const cid = await web3Storage.put([file], {
                            name: file.name,
                            maxRetries: 3,
                            wrapWithDirectory: false,
                        });
                        await this.contractSet.createProfile(options.identity, username, `ipfs://${cid}`);

                        return {
                            code: 0,
                            message: 'Success',
                        };
                    }
                    default:
                        throw new Error(`Unsupported platform: ${options.platform}`);
                }
            }
            default:
                throw new Error(`Unsupported action: ${options.action}`);
        }
    }
}

export default CrossbellProfile;
