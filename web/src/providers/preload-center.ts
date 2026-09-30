'use client'
import { CENTER_WALLET_ENABLED } from './wallet-config'
export function preloadCenterWallet() { if (CENTER_WALLET_ENABLED) void import('./center-runtime') }
