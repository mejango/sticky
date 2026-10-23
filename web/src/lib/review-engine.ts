/** Core's send engine, out of every page's first load: the reviewed run loads it, and the page preloads it on intent. */
export const loadReviewEngine = () => import('@bananapus/nana-sdk-core/review')
