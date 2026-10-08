#!/bin/sh
# Reuse the deployment environment for read-only tests against pinned mainnet state.
set -eu
cd "$(dirname "$0")/.."
set -a
if [ -n "${STICKY_ENV_FILE:-}" ]; then
  . "$STICKY_ENV_FILE"
elif [ -f ./.env ]; then
  . ./.env
fi
set +a
: "${RPC_ETHEREUM_MAINNET:?Set RPC_ETHEREUM_MAINNET to an Ethereum archive RPC}"
: "${RPC_BASE_MAINNET:?Set RPC_BASE_MAINNET to a Base archive RPC}"
# Full qualification spans all four chains. Focused runs keep the existing
# Ethereum/Base preflight; Foundry reports any other RPC their selected tests need.
focused=false
for argument in "$@"; do
  case "$argument" in
    --match-contract|--match-contract=*|--mc|--mc=*|--match-path|--match-path=*|--mp|--mp=*|--match-test|--match-test=*|--mt|--mt=*) focused=true ;;
  esac
done
if [ "$focused" = false ]; then
  : "${RPC_OPTIMISM_MAINNET:?Set RPC_OPTIMISM_MAINNET to an Optimism archive RPC}"
  : "${RPC_ARBITRUM_MAINNET:?Set RPC_ARBITRUM_MAINNET to an Arbitrum archive RPC}"
fi
export FOUNDRY_PROFILE=fork
# The Arbitrum opcode-capture helper requires Foundry's level-3 trace recorder.
# Keep archive RPC requests and trace memory bounded with one fork-test worker.
exec forge test -vvv --threads 1 --deny notes --summary --detailed --skip '*/script/**' "$@"
