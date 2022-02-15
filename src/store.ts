import { walletsDbService } from "@/api/database/walletsDbService";
import { createStore } from "vuex";
import Bip32, { DerivedAddress } from "@/api/ergo/bip32";
import { explorerService } from "@/api/explorer/explorerService";
import BigNumber from "bignumber.js";
import { coinGeckoService } from "@/api/coinGeckoService";
import {
  groupBy,
  sortBy,
  find,
  findIndex,
  last,
  take,
  first,
  maxBy,
  clone,
  findLastIndex,
  isEmpty
} from "lodash";
import {
  Network,
  WalletType,
  AddressState,
  AddressType,
  SendTxCommand,
  SignTxFromConnectorCommand,
  UpdateWalletSettingsCommand,
  UpdateChangeIndexCommand
} from "@/types/internal";
import { bip32Pool } from "@/utils/objectPool";
import { StateAddress, StateAsset, StateWallet, StateTokenMarketRates } from "@/types/internal";
import { MUTATIONS, GETTERS, ACTIONS } from "@/constants/store";
import { setDecimals, toBigNumber } from "@/utils/bigNumbers";
import { ERG_TOKEN_ID, CHUNK_DERIVE_LENGTH, ERG_DECIMALS } from "@/constants/ergo";
import { IDbAddress, IDbAsset, IDbDAppConnection, IDbWallet } from "@/types/database";
import router from "@/router";
import { addressesDbService } from "@/api/database/addressesDbService";
import { assestsDbService } from "@/api/database/assetsDbService";
import AES from "crypto-js/aes";
import { Transaction } from "./api/ergo/transaction/transaction";
import { SignContext } from "./api/ergo/transaction/signContext";
import { connectedDAppsDbService } from "./api/database/connectedDAppsDbService";
import { rpcHandler } from "./background/rpcHandler";
import { extractAddressesFromInputs } from "./api/ergo/addresses";
import { ITokenRate } from "ergo-market-lib";

function dbAddressMapper(a: IDbAddress) {
  return {
    script: a.script,
    state: a.state,
    index: a.index,
    balance: undefined
  };
}

export default createStore({
  state: {
    ergPrice: 0,
    wallets: [] as StateWallet[],
    currentWallet: {
      id: 0,
      name: "",
      type: WalletType.Standard,
      publicKey: "",
      extendedPublicKey: "",
      settings: {
        avoidAddressReuse: false,
        hideUsedAddresses: false,
        defaultChangeIndex: 0
      }
    } as StateWallet,
    currentAddresses: [] as StateAddress[],
    settings: {
      lastOpenedWalletId: 0,
      isKyaAccepted: false
    },
    loading: {
      settings: true,
      price: false,
      addresses: true,
      balance: true
    },
    connections: Object.freeze([] as IDbDAppConnection[]),
    tokenMarketRates: { } as StateTokenMarketRates,
  },
  getters: {
    [GETTERS.BALANCE](state) {
      const balance: StateAsset[] = [];

      const groups = groupBy(
        state.currentAddresses
          .filter((a) => a.balance)
          .map((a) => a.balance || [])
          .flat(),
        (a) => a?.tokenId
      );

      for (const key in groups) {
        const group = groups[key];
        if (group.length === 0) {
          continue;
        }

        const token: StateAsset = {
          tokenId: group[0].tokenId,
          name: group[0].name,
          confirmedAmount: group.map((a) => a.confirmedAmount).reduce((acc, val) => acc.plus(val)),
          unconfirmedAmount: group
            .map((a) => a.unconfirmedAmount)
            .reduce((acc, val) => acc?.plus(val || 0)),
          decimals: group[0].decimals,
          price:
            group[0].tokenId === ERG_TOKEN_ID
              ? state.ergPrice
              : (group[0].latestValueInErgs || 0) * state.ergPrice,
          latestValueInErgs: group[0].tokenId === ERG_TOKEN_ID ? 1 : group[0].price
        };

        balance.push(token);
      }

      if (isEmpty(balance)) {
        balance.push({
          name: "ERG",
          tokenId: ERG_TOKEN_ID,
          decimals: ERG_DECIMALS,
          confirmedAmount: new BigNumber(0),
          price: state.ergPrice
        });

        return balance;
      }

      return sortBy(balance, [(a) => a.tokenId !== ERG_TOKEN_ID, (a) => a.name]);
    },
    [GETTERS.MARKET_RATES](state) {
      return state.tokenMarketRates;
    },
    [GETTERS.ERG_PRICE](state) {
      return state.ergPrice;
    }
  },
  mutations: {
    [MUTATIONS.SET_CURRENT_WALLET](state, identifier: StateWallet | number) {
      const selected =
        typeof identifier === "number"
          ? find(state.wallets, (w) => w.id == identifier)
          : identifier;

      if (!selected || !selected.id) {
        throw Error("Wallet not found");
      }

      if (typeof identifier !== "number") {
        const i = findIndex(state.wallets, (x) => x.id == selected.id);
        if (i > -1) {
          state.wallets[i] = selected;
        } else {
          state.wallets.push(selected);
        }
      }

      state.currentWallet = selected;
    },
    [MUTATIONS.SET_CURRENT_ADDRESSES](
      state,
      content: { addresses: StateAddress[]; walletId?: number }
    ) {
      // don't commit if the default wallet gets changed
      if (state.currentWallet.id !== content.walletId) {
        return;
      }

      if (state.currentAddresses.length !== 0) {
        for (const address of content.addresses) {
          const stateAddr = find(state.currentAddresses, (a) => a.script === address.script);
          if (stateAddr && stateAddr.balance) {
            address.balance = stateAddr.balance;
          }
        }
      }

      state.currentAddresses = sortBy(content.addresses, (a) => a.index);
    },
    [MUTATIONS.ADD_ADDRESS](state, content: { address: StateAddress; walletId: number }) {
      if (state.currentWallet.id != content.walletId) {
        return;
      }

      state.currentAddresses.push(content.address);
    },
    [MUTATIONS.UPDATE_BALANCES](state, data: { assets: IDbAsset[]; walletId: number }) {
      if (
        !data.assets ||
        data.assets.length === 0 ||
        state.currentAddresses.length === 0 ||
        state.currentWallet.id !== data.walletId
      ) {
        return;
      }

      const groups = groupBy(data.assets, (a) => a.address);
      for (const address of state.currentAddresses) {
        const group = groups[address.script];
        if (!group || group.length === 0) {
          address.balance = undefined;
          continue;
        }

        address.balance = group.map((x) => {
          return {
            tokenId: x.tokenId,
            name: x.name,
            confirmedAmount:
              setDecimals(toBigNumber(x.confirmedAmount), x.decimals) || new BigNumber(0),
            unconfirmedAmount: setDecimals(toBigNumber(x.unconfirmedAmount), x.decimals),
            decimals: x.decimals,
            price: state.ergPrice * state.tokenMarketRates[x.tokenId]?.latestValueInErgs,
            latestValueInErgs: state.tokenMarketRates[x.tokenId]?.latestValueInErgs
          };
        });
      }
    },
    [MUTATIONS.SET_ERG_PRICE](state, price) {
      state.loading.price = false;
      state.ergPrice = price;
    },
    [MUTATIONS.SET_LOADING](state, obj) {
      state.loading = Object.assign(state.loading, obj);
    },
    [MUTATIONS.SET_WALLETS](state, wallets: IDbWallet[]) {
      state.wallets = wallets.map((w) => {
        return {
          id: w.id || 0,
          name: w.name,
          type: w.type,
          publicKey: w.publicKey,
          extendedPublicKey: bip32Pool.get(w.publicKey).extendedPublicKey.toString("hex"),
          balance: new BigNumber(0),
          settings: w.settings
        };
      });
    },
    [MUTATIONS.SET_SETTINGS](state, settings) {
      state.settings = Object.assign(state.settings, settings);
    },
    [MUTATIONS.SET_CONNECTIONS](state, connections) {
      state.connections = Object.freeze(connections);
    },
    [MUTATIONS.SET_WALLET_SETTINGS](state, command: UpdateWalletSettingsCommand) {
      const wallet = find(state.wallets, (w) => w.id === command.walletId);
      if (!wallet) {
        return;
      }

      wallet.name = command.name;
      wallet.settings.avoidAddressReuse = command.avoidAddressReuse;
      wallet.settings.hideUsedAddresses = command.hideUsedAddresses;
    },
    [MUTATIONS.UPDATE_DEFAULT_CHANGE_INDEX](state, command: UpdateChangeIndexCommand) {
      const wallet = find(state.wallets, (w) => w.id === command.walletId);
      if (!wallet) {
        return;
      }

      wallet.settings.defaultChangeIndex = command.index;
    },
    [MUTATIONS.SET_MARKET_RATES](state, rates: ITokenRate[]) {
      rates.forEach((tokenRate) => {
        const currentTokenRates = state.tokenMarketRates[tokenRate.token.tokenId] || {
          ratesOverTime: []
        };
        currentTokenRates.latestValueInErgs = tokenRate.ergPerToken;
        if (currentTokenRates.ratesOverTime.length > 500)
          currentTokenRates.ratesOverTime.splice(0, 1);
        const lastRate = currentTokenRates.ratesOverTime.pop();
        lastRate && currentTokenRates.ratesOverTime.push(lastRate);
        // Only add new rate (over 10) if it differs from previous rate, charts will distance the points based on timestamps
        if (
          currentTokenRates.ratesOverTime.length < 10 ||
          lastRate?.ergPerToken !== tokenRate.ergPerToken
        ) currentTokenRates.ratesOverTime.push(tokenRate);
        state.tokenMarketRates[tokenRate.token.tokenId] = currentTokenRates;
      });
    }
  },
  actions: {
    async [ACTIONS.INIT]({ state, dispatch }) {
      dispatch(ACTIONS.LOAD_SETTINGS);
      await dispatch(ACTIONS.LOAD_WALLETS);

      if (state.wallets.length > 0) {
        dispatch(ACTIONS.LOAD_CONNECTIONS);
        let current = find(state.wallets, (w) => w.id === state.settings.lastOpenedWalletId);
        if (!current) {
          current = first(state.wallets);
        }
        dispatch(ACTIONS.SET_CURRENT_WALLET, current);

        if (router.currentRoute.value.query.popup != "true") {
          router.push({ name: "assets-page" });
        }
      } else {
        router.push({ name: "add-wallet" });
      }
    },
    async [ACTIONS.LOAD_MARKET_RATES]({ commit }) {
      const tokenMarketRates = await explorerService.getTokenMarketRates();
      commit(MUTATIONS.SET_MARKET_RATES, tokenMarketRates);
    },
    [ACTIONS.LOAD_SETTINGS]({ commit }) {
      const rawSettings = localStorage.getItem("settings");
      if (rawSettings) {
        commit(MUTATIONS.SET_SETTINGS, JSON.parse(rawSettings));
      }
      commit(MUTATIONS.SET_LOADING, { settings: false });
    },
    [ACTIONS.SAVE_SETTINGS]({ state, commit }, newSettings) {
      if (newSettings) {
        commit(MUTATIONS.SET_SETTINGS, newSettings);
      }
      localStorage.setItem("settings", JSON.stringify(state.settings));
    },
    async [ACTIONS.LOAD_WALLETS]({ commit }) {
      const wallets = await walletsDbService.getAll();
      if (isEmpty(wallets)) {
        return;
      }

      for (const wallet of wallets) {
        bip32Pool.alloc(
          Bip32.fromPublicKey({ publicKey: wallet.publicKey, chainCode: wallet.chainCode }),
          wallet.publicKey
        );
      }

      commit(MUTATIONS.SET_WALLETS, wallets);
    },
    async [ACTIONS.PUT_WALLET](
      { dispatch },
      wallet:
        | { extendedPublicKey: string; name: string; type: WalletType.ReadOnly }
        | { mnemonic: string; password: string; name: string; type: WalletType.Standard }
    ) {
      const bip32 =
        wallet.type === WalletType.ReadOnly
          ? Bip32.fromPublicKey(wallet.extendedPublicKey)
          : await Bip32.fromMnemonic(wallet.mnemonic);

      bip32Pool.alloc(bip32.neutered(), bip32.publicKey.toString("hex"));
      const walletId = await walletsDbService.put({
        name: wallet.name.trim(),
        network: Network.ErgoMainet,
        type: wallet.type,
        publicKey: bip32.publicKey.toString("hex"),
        chainCode: bip32.chainCode.toString("hex"),
        mnemonic:
          wallet.type === WalletType.Standard
            ? AES.encrypt(wallet.mnemonic, wallet.password).toString()
            : undefined,
        settings: {
          avoidAddressReuse: false,
          hideUsedAddresses: false,
          defaultChangeIndex: 0
        }
      });

      await dispatch(ACTIONS.FETCH_AND_SET_AS_CURRENT_WALLET, walletId);
    },
    async [ACTIONS.FETCH_AND_SET_AS_CURRENT_WALLET]({ dispatch }, id: number) {
      const wallet = await walletsDbService.getById(id);
      if (!wallet || !wallet.id) {
        throw Error("wallet not found");
      }

      const bip32 = bip32Pool.get(wallet.publicKey);
      const stateWallet: StateWallet = {
        id: wallet.id,
        name: wallet.name,
        type: wallet.type,
        publicKey: wallet.publicKey,
        extendedPublicKey: bip32.extendedPublicKey.toString("hex"),
        settings: wallet.settings
      };

      await dispatch(ACTIONS.SET_CURRENT_WALLET, stateWallet);
      await dispatch(ACTIONS.REFRESH_CURRENT_ADDRESSES);
    },
    [ACTIONS.SET_CURRENT_WALLET]({ commit, dispatch }, wallet: StateWallet | number) {
      const walletId = typeof wallet === "number" ? wallet : wallet.id;

      commit(MUTATIONS.SET_LOADING, { balance: true, addresses: true });
      commit(MUTATIONS.SET_CURRENT_WALLET, wallet);
      commit(MUTATIONS.SET_CURRENT_ADDRESSES, { addresses: [], walletId });
      dispatch(ACTIONS.REFRESH_CURRENT_ADDRESSES);
      dispatch(ACTIONS.SAVE_SETTINGS, { lastOpenedWalletId: walletId });
    },
    async [ACTIONS.NEW_ADDRESS]({ state, commit }) {
      const lastUsedIndex = findLastIndex(
        state.currentAddresses,
        (a) => a.state === AddressState.Used
      );

      if (state.currentAddresses.length - lastUsedIndex > CHUNK_DERIVE_LENGTH) {
        throw Error(
          `You cannot add more than ${CHUNK_DERIVE_LENGTH} consecutive unused addresses.`
        );
      }
      const walletId = state.currentWallet.id;
      const pk = state.currentWallet.publicKey;
      const index = (maxBy(state.currentAddresses, (a) => a.index)?.index || 0) + 1;
      const bip32 = bip32Pool.get(pk);
      const address = bip32.deriveAddress(index);
      await addressesDbService.put({
        type: AddressType.P2PK,
        state: AddressState.Unused,
        script: address.script,
        index: address.index,
        walletId: walletId
      });

      commit(MUTATIONS.ADD_ADDRESS, {
        address: {
          script: address.script,
          state: AddressState.Unused,
          index: address.index,
          balance: undefined
        },
        walletId
      });
    },
    async [ACTIONS.REFRESH_CURRENT_ADDRESSES]({ state, commit, dispatch }) {
      if (!state.currentWallet.id) {
        return;
      }

      const walletId = state.currentWallet.id;
      const pk = state.currentWallet.publicKey;
      const bip32 = bip32Pool.get(pk);
      let active: StateAddress[] = sortBy(
        (await addressesDbService.getByWalletId(walletId)).map((a) => dbAddressMapper(a)),
        (a) => a.index
      );
      let derived: DerivedAddress[] = [];
      let used: string[] = [];
      let usedChunk: string[] = [];
      let lastUsed: string | undefined;
      let lastStored = last(active)?.script;
      const maxIndex = maxBy(active, (a) => a.index)?.index;
      let offset = maxIndex !== undefined ? maxIndex + 1 : 0;

      if (active.length > 0) {
        if (state.currentAddresses.length === 0) {
          commit(MUTATIONS.SET_CURRENT_ADDRESSES, { addresses: clone(active), walletId });
          dispatch(ACTIONS.LOAD_BALANCES, walletId);
        }

        used = used.concat(
          await explorerService.getUsedAddresses(
            active.map((a) => a.script),
            { chunkBy: CHUNK_DERIVE_LENGTH }
          )
        );
        lastUsed = last(used);
      }

      do {
        derived = bip32.deriveAddresses(CHUNK_DERIVE_LENGTH, offset);
        offset += derived.length;
        usedChunk = await explorerService.getUsedAddresses(derived.map((a) => a.script));
        used = used.concat(usedChunk);
        active = active.concat(
          derived.map((d) => ({
            index: d.index,
            script: d.script,
            state: AddressState.Unused,
            balance: undefined
          }))
        );
        if (usedChunk.length > 0) {
          lastUsed = last(usedChunk);
        }
      } while (usedChunk.length > 0);

      const lastUsedIndex = findIndex(active, (a) => a.script === lastUsed);
      const lastStoredIndex = findIndex(active, (a) => a.script === lastStored);
      if (lastStoredIndex > lastUsedIndex) {
        active = take(active, lastStoredIndex + 1);
      } else if (lastUsedIndex > -1) {
        active = take(active, lastUsedIndex + 2);
      } else {
        active = take(active, 1);
      }

      for (const addr of active) {
        if (find(used, (address) => addr.script === address)) {
          addr.state = AddressState.Used;
        }
      }

      await addressesDbService.bulkPut(
        active.map((a) => {
          return {
            type: AddressType.P2PK,
            state: a.state,
            script: a.script,
            index: a.index,
            walletId: walletId
          };
        }),
        walletId
      );

      const addr = (await addressesDbService.getByWalletId(walletId)).map((a: IDbAddress) => {
        return {
          script: a.script,
          state: a.state,
          index: a.index,
          balance: undefined
        };
      });
      commit(MUTATIONS.SET_CURRENT_ADDRESSES, { addresses: addr, walletId: walletId });

      if (lastUsed !== null) {
        dispatch(ACTIONS.REFRESH_BALANCES, {
          addresses: active.map((a) => a.script),
          walletId
        });
      }

      commit(MUTATIONS.SET_LOADING, { addresses: false });
    },
    async [ACTIONS.LOAD_BALANCES]({ commit, dispatch }, walletId: number) {
      const assets = await assestsDbService.getByWalletId(walletId);
      dispatch(ACTIONS.LOAD_MARKET_RATES);
      commit(MUTATIONS.UPDATE_BALANCES, { assets, walletId: walletId });
    },
    async [ACTIONS.REFRESH_BALANCES]({ commit, dispatch }, data: { addresses: string[]; walletId: number }) {
      const balances = await explorerService.getAddressesBalance(data.addresses);
      const assets = assestsDbService.parseAddressBalanceAPIResponse(balances, data.walletId);
      assestsDbService.sync(assets, data.walletId);

      dispatch(ACTIONS.LOAD_MARKET_RATES);
      commit(MUTATIONS.UPDATE_BALANCES, { assets, walletId: data.walletId });
      commit(MUTATIONS.SET_LOADING, { balance: false });
    },
    async [ACTIONS.FETCH_CURRENT_PRICES]({ commit, state }) {
      if (state.loading.price) {
        return;
      }

      state.loading.price = true;
      const responseData = await coinGeckoService.getPrice();
      commit(MUTATIONS.SET_ERG_PRICE, responseData.ergo.usd);
    },
    async [ACTIONS.SEND_TX]({ dispatch, state }, command: SendTxCommand) {
      if (state.currentWallet.settings.avoidAddressReuse) {
        let unused = find(
          state.currentAddresses,
          (a) => a.state === AddressState.Unused && a.script !== command.recipient
        );
        if (!unused) {
          await dispatch(ACTIONS.NEW_ADDRESS);
        }
      }

      const addresses = state.currentAddresses;
      const selectedAddresses = addresses.filter((a) => a.state === AddressState.Used && a.balance);
      const bip32 = await Bip32.fromMnemonic(
        await walletsDbService.getMnemonic(command.walletId, command.password)
      );
      command.password = "";

      const changeAddress = state.currentWallet.settings.avoidAddressReuse
        ? find(addresses, (a) => a.state === AddressState.Unused && a.script !== command.recipient)
            ?.index ?? state.currentWallet.settings.defaultChangeIndex
        : state.currentWallet.settings.defaultChangeIndex;

      const boxes = await explorerService.getUnspentBoxes(selectedAddresses.map((a) => a.script));
      const blockHeaders = await explorerService.getLastTenBlockHeaders();

      const signedtx = Transaction.from(selectedAddresses)
        .to(command.recipient)
        .changeIndex(changeAddress ?? 0)
        .withAssets(command.assets)
        .withFee(command.fee)
        .fromBoxes(boxes.map((a) => a.data).flat())
        .sign(SignContext.fromBlockHeaders(blockHeaders).withBip32(bip32));

      const response = await explorerService.sendTx(signedtx);
      return response.id;
    },
    async [ACTIONS.SIGN_TX_FROM_CONNECTOR]({ state }, command: SignTxFromConnectorCommand) {
      const addressesFromBoxes = extractAddressesFromInputs(command.tx.inputs);
      console.log(addressesFromBoxes);
      const dbAddresses = await addressesDbService.getByWalletId(command.walletId);
      const addresses = dbAddresses
        .filter((a) => addressesFromBoxes.includes(a.script))
        .map((a) => dbAddressMapper(a));
      console.log(addresses);
      const bip32 = await Bip32.fromMnemonic(
        await walletsDbService.getMnemonic(command.walletId, command.password)
      );
      command.password = "";

      const blockHeaders = await explorerService.getLastTenBlockHeaders();
      const signedtx = Transaction.from(addresses).signFromConnector(
        command.tx,
        SignContext.fromBlockHeaders(blockHeaders).withBip32(bip32)
      );

      return signedtx;
    },

    async [ACTIONS.LOAD_CONNECTIONS]({ commit }) {
      const connections = await connectedDAppsDbService.getAll();
      commit(MUTATIONS.SET_CONNECTIONS, connections);
    },
    async [ACTIONS.REMOVE_CONNECTION]({ dispatch }, origin: string) {
      await connectedDAppsDbService.deleteByOrigin(origin);
      dispatch(ACTIONS.LOAD_CONNECTIONS);
      rpcHandler.sendEvent("disconnected", origin);
    },
    async [ACTIONS.UPDATE_WALLET_SETTINGS]({ commit }, commad: UpdateWalletSettingsCommand) {
      await walletsDbService.updateSettings(commad.walletId, commad.name, commad);
      commit(MUTATIONS.SET_WALLET_SETTINGS, commad);
    },
    async [ACTIONS.UPDATE_CHANGE_ADDRESS_INDEX]({ commit }, commad: UpdateChangeIndexCommand) {
      await walletsDbService.updateChangeIndex(commad.walletId, commad.index);
      commit(MUTATIONS.UPDATE_DEFAULT_CHANGE_INDEX, commad);
    }
  }
});
