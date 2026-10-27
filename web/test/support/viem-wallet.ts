import {
  createWalletClient,
  custom,
  getAddress,
  hexToBigInt,
  hexToString,
  numberToHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

/** JSON's strings back to the values viem took: bigints and checksummed addresses. */
function revive(
  types: Record<string, { name: string; type: string }[]>,
  type: string,
  value: unknown,
): unknown {
  if (type.endsWith("]"))
    return (value as unknown[]).map((item) =>
      revive(types, type.slice(0, type.lastIndexOf("[")), item),
    );
  if (types[type])
    return Object.fromEntries(
      types[type].map(({ name, type: field }) => [
        name,
        revive(types, field, (value as Record<string, unknown>)[name]),
      ]),
    );
  // ponytail: the app passes uint8..uint48 as numbers and wider ones as bigints.
  const width = /^u?int(\d*)$/.exec(type)?.[1];
  if (width !== undefined)
    return Number(width || 256) <= 48 ? Number(value) : BigInt(value as string);
  if (type === "address") return getAddress(value as string);
  return value;
}

type Fake = {
  sendTransaction?: (tx: {
    account?: Address;
    chain: { id: number };
    to: Address;
    data: Hex;
    value: bigint;
    gas?: bigint;
  }) => unknown;
  signTypedData?: (typedData: Record<string, unknown> & { account: Address }) => unknown;
  signMessage?: (request: { account: Address; message: string }) => unknown;
  sendCalls?: (request: {
    account: Address;
    chain: { id: number };
    calls: { to: Address; data: Hex; value: bigint }[];
  }) => unknown;
};

/**
 * A real viem wallet client whose provider hands each request to `fake`'s method, as a test's
 * fake wallet takes it. Core's wallet adapter checks the connection at the provider request, so a
 * fake wallet must be reached through a provider, never as an object with methods.
 */
export function viemWallet(fake: Fake, chainId: () => number | undefined): WalletClient {
  const chain = () => chainId() ?? 1;
  const call = (method: keyof Fake, request: unknown) => {
    if (!fake[method]) throw new Error(`Unexpected wallet request ${method}`);
    return (fake[method] as (request: unknown) => unknown)(request);
  };
  return createWalletClient({
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === "eth_chainId") return numberToHex(chain());
          if (method === "eth_sendTransaction") {
            const [tx] = params as [
              { from?: Address; to: Address; data?: Hex; value?: Hex; gas?: Hex; chainId?: Hex },
            ];
            return call("sendTransaction", {
              ...(tx.from ? { account: tx.from } : {}),
              chain: { id: tx.chainId ? Number(tx.chainId) : chain() },
              to: tx.to,
              data: tx.data ?? "0x",
              value: tx.value ? hexToBigInt(tx.value) : 0n,
              ...(tx.gas ? { gas: hexToBigInt(tx.gas) } : {}),
            });
          }
          if (method === "eth_signTypedData_v4") {
            const [account, json] = params as [Address, string];
            const { types, domain, primaryType, message } = JSON.parse(json) as {
              types: Record<string, { name: string; type: string }[]>;
              domain: Record<string, unknown>;
              primaryType: string;
              message: Record<string, unknown>;
            };
            const { EIP712Domain: _domain, ...rest } = types;
            return call("signTypedData", {
              account,
              domain: {
                ...domain,
                ...(domain.chainId === undefined ? {} : { chainId: Number(domain.chainId) }),
                ...(domain.verifyingContract
                  ? { verifyingContract: getAddress(domain.verifyingContract as string) }
                  : {}),
              },
              types: rest,
              primaryType,
              message: revive(rest, primaryType, message),
            });
          }
          if (method === "personal_sign") {
            const [message, account] = params as [Hex, Address];
            return call("signMessage", { account, message: hexToString(message) });
          }
          if (method === "wallet_sendCalls") {
            const [request] = params as [
              { from: Address; chainId: Hex; calls: { to: Address; data?: Hex; value?: Hex }[] },
            ];
            return call("sendCalls", {
              account: request.from,
              chain: { id: Number(request.chainId) },
              calls: request.calls.map(({ to, data, value }) => ({
                to,
                data: data ?? "0x",
                value: value ? hexToBigInt(value) : 0n,
              })),
            });
          }
          throw new Error(`Unexpected wallet request ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  });
}
