import Image from 'next/image'
import heroDonut from '../../../public/assets/hero-donut.png'

/**
 * The home's hero: the donut, what Sticky is, the home's note (and Try again when a read failed), the button that
 * makes a token sticky, and where the code is. The note sits in a live region that is always there, so a note that
 * appears is announced.
 */
export function HomeHero({
  note,
  error,
  onRetry,
  onCreate,
}: {
  note: string
  /** Whether the note says a read failed. */
  error: boolean
  onRetry?: () => void
  /** Opens the create form. Without it the button is disabled. */
  onCreate?: () => void
}) {
  return (
    <section className="px-[22px] pb-[26px] pt-[46px] text-center">
      <Image
        src={heroDonut}
        alt=""
        width={230}
        height={209}
        sizes="230px"
        loading="eager"
        className="mx-auto mb-2 block h-auto w-[230px] max-w-[70%]"
      />
      <h1 className="mb-1.5 font-agrandir-wide text-[34px] leading-tight">Sticky</h1>
      <p className="mb-4 text-[17px]">
        Mark your presence,
        <br />
        earn by sticking around.
      </p>
      <div role="status" aria-live="polite">
        {note ? (
          <p className={`mx-auto -mt-1 mb-4 max-w-[34ch] text-[15px] ${error ? 'text-err' : 'text-muted'}`}>
            <span>{note}</span>
            {onRetry ? (
              <>
                {' '}
                <button type="button" className="btn-link font-semibold" onClick={onRetry}>
                  Try again
                </button>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      <button type="button" className="btn-primary mt-2.5 px-4 py-[9px]" onClick={onCreate} disabled={!onCreate}>
        Make your token sticky
      </button>
      <p className="mt-3.5 text-[15px] text-muted">
        100% open source,{' '}
        <a
          className="text-accent underline decoration-amber"
          href="https://github.com/mejango/sticky"
          target="_blank"
          rel="noopener noreferrer"
        >
          audit or create with your AI
        </a>
        .
      </p>
    </section>
  )
}
