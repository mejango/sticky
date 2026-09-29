const linkClass = 'text-accent underline decoration-amber'

export function SiteFooter() {
  return (
    <footer className="mt-[46px] pb-2 pt-[26px] text-center text-muted">
      <div className="border-t border-line pt-4 text-[13px]">
        <p className="my-1">
          Sticky tokens are open source, enforced by the Juicebox protocol on
          each supported chain.
        </p>
        <p className="my-1">
          Review the{' '}
          <a
            className={linkClass}
            href="https://github.com/mejango/sticky"
            target="_blank"
            rel="noopener noreferrer"
          >
            contract code
          </a>{' '}
          and the{' '}
          <a
            className={linkClass}
            href="https://github.com/mejango/sticky/tree/main/web"
            target="_blank"
            rel="noopener noreferrer"
          >
            website code
          </a>
          .
        </p>
        <p className="my-1">
          Terms of service: Risks are borne entirely by the users of the open
          source code.
        </p>
      </div>
    </footer>
  )
}
