import { describe, expect, it } from "vitest";
import { offerableWallets } from "@/lib/wallet-list";

const announced = (id: string, name: string) => ({ id, name, icon: "data:image/svg+xml,x" });
const configured = (id: string, name: string) => ({ id, name, icon: undefined });

describe("offerableWallets", () => {
  it("lists a wallet once when the extension and our SDK connector collide", () => {
    // The bug this exists for: Coinbase ships both, under one name and two
    // ids, so an id-based filter showed "Coinbase Wallet" twice.
    const list = offerableWallets([
      announced("com.coinbase.wallet", "Coinbase Wallet"),
      configured("coinbaseWalletSDK", "Coinbase Wallet"),
    ]);

    expect(list).toHaveLength(1);
    // The announced one wins: the extension is installed, so there is no
    // reason to make the visitor load the SDK.
    expect(list[0].id).toBe("com.coinbase.wallet");
  });

  it("keeps the announced wallet even when our connector is listed first", () => {
    const list = offerableWallets([
      configured("coinbaseWalletSDK", "Coinbase Wallet"),
      announced("com.coinbase.wallet", "Coinbase Wallet"),
    ]);

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("com.coinbase.wallet");
  });

  it("drops the generic injected connector once anything is announced", () => {
    const list = offerableWallets([
      configured("injected", "Injected"),
      announced("io.metamask", "MetaMask"),
    ]);

    expect(list.map((c) => c.id)).toEqual(["io.metamask"]);
  });

  it("keeps injected as the only way in when nothing is announced", () => {
    const list = offerableWallets([configured("injected", "Injected")]);

    expect(list.map((c) => c.id)).toEqual(["injected"]);
  });

  it("never offers Para, which is not a wallet the user picks here", () => {
    const list = offerableWallets([
      configured("para", "Para"),
      announced("io.metamask", "MetaMask"),
    ]);

    expect(list.map((c) => c.id)).toEqual(["io.metamask"]);
  });

  it("never offers the Signa account as a wallet tile: it has its own button", () => {
    const list = offerableWallets([
      configured("juicebox-center", "Juicebox account"),
      announced("io.metamask", "MetaMask"),
    ]);

    expect(list.map((c) => c.id)).toEqual(["io.metamask"]);
    expect(offerableWallets([configured("juicebox-center", "Juicebox account")])).toEqual([]);
  });

  it("counts an injected wallet without an icon as announced", () => {
    const list = offerableWallets([
      configured("injected", "Injected"),
      { id: "io.rabby", name: "Rabby", icon: undefined, type: "injected" },
    ]);

    expect(list.map((c) => c.id)).toEqual(["io.rabby"]);
  });
});
