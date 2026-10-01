/** The Safe setup ABIs the review dialog decodes a new Safe's initializer with. */

export const safeToL2SetupAbi = [
  {
    type: 'function',
    name: 'setupToL2',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'l2Singleton', type: 'address' }],
    outputs: [],
  },
] as const

export const safeSetupAbi = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const
