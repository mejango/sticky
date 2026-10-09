import type { StickySourceCollectorDeployment } from '@bananapus/nana-sdk-core/v6'
import records from '@/lib/sticky-source-collectors.json'

/** Generated only from verified, executed destination-family deployment records. */
export const stickySourceCollectors: readonly StickySourceCollectorDeployment[] = records as StickySourceCollectorDeployment[]
