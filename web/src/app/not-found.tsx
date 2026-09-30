import { HomeLink } from '@/components/HomeLink'

/** What an address with no page shows: a route that does not exist, or a project, handle or account that does not. */
export default function NotFound() {
  return (
    <section className="card mx-auto mt-10 max-w-[560px] p-6 text-center">
      <h1 className="font-agrandir-wide text-[26px] leading-tight">Page not found</h1>
      <p className="mt-3.5 text-muted">Check the address for typos.</p>
      <HomeLink className="btn-primary mt-5 px-4 py-[9px]">Back to home</HomeLink>
    </section>
  )
}
