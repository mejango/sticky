import { createWriteHold } from '@bananapus/nana-sdk-core/review'

/** One controller for every held write of the app: storage, locks, the states and the exits live in the SDK. */
export const holds = createWriteHold()
