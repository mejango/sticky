// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice A holder's shares joined in one epoch. Additions in the same epoch merge into this tranche and refresh
/// its timestamp to the latest addition.
/// @custom:member amount The number of staked project tokens this tranche represents, as a fixed point number with 18
/// decimals.
/// @custom:member timestamp The timestamp of the latest positive addition to this tranche. Partial unstakes keep
/// the remainder's timestamp unchanged.
// Keep the shared Juicebox acronym intact in public types throughout V6.
// forge-lint: disable-next-line(pascal-case-struct)
struct StickyTranche {
    uint208 amount;
    uint48 timestamp;
}
