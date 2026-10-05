/** A list of labels and values: two columns, or one on a phone, with no line under the last row. */
export const DETAIL_LIST =
  'm-0 grid grid-cols-[max-content_minmax(0,1fr)] text-sm max-[560px]:grid-cols-[minmax(0,1fr)] [&>dd:last-of-type]:border-b-0 [&>dt:last-of-type]:border-b-0'

/** A label's style: beside its value, or above it on a phone. */
export const DETAIL_LABEL =
  'whitespace-nowrap border-b border-line py-2 pr-4 text-muted max-[560px]:border-b-0 max-[560px]:pb-0 max-[560px]:text-xs'

/** A value that may break anywhere, like an address, under its label on a phone. */
export const DETAIL_VALUE = 'm-0 min-w-0 border-b border-line py-2 max-[560px]:pt-0.5'
