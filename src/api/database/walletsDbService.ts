import { IDbWallet } from "@/types/database";
import { dbContext } from "@/api/database/dbContext";
import AES from "crypto-js/aes";
import utf8Enc from "crypto-js/enc-utf8";

class WalletsDbService {
  public async getFromId(id: number): Promise<IDbWallet | undefined> {
    return await dbContext.wallets.where("id").equals(id).first();
  }

  public async getMnemonic(id: number, password: string) {
    const wallet = await this.getFromId(id);
    if (!wallet) {
      throw Error("wallet not found");
    }
    if (!wallet.mnemonic) {
      throw Error("wallet doesn't have a mnemonic phrase");
    }

    return AES.decrypt(wallet.mnemonic, password).toString(utf8Enc);
  }

  public async getFromPk(publicKey: string): Promise<IDbWallet | undefined> {
    return await dbContext.wallets.where("publicKey").equals(publicKey).first();
  }

  public async put(wallet: IDbWallet): Promise<number> {
    const dbWallet = await this.getFromPk(wallet.publicKey);
    if (!wallet.id) {
      wallet.id = dbWallet?.id;
    }

    return dbContext.wallets.put(wallet);
  }

  public async getAll(): Promise<IDbWallet[]> {
    return await dbContext.wallets.toArray();
  }
}

export const walletsDbService = new WalletsDbService();
