/**
 * The wallet-prompt queue for a multi-transaction flow, shown before the first
 * prompt so a signer knows how many are coming and why. Steps are strictly
 * sequential: everything before `activeIndex` is done, and a flow that has
 * finished passes `steps.length`. Pass -1 while nothing is running yet.
 */
export function TxSteps({
  steps,
  activeIndex,
  intro,
  ariaLabel,
  className = 'mt-3 rounded-xl border border-smoke-200 bg-white p-3',
}: {
  steps: readonly {
    /** Stable list key; falls back to the title when it is a plain string. */
    key?: string
    title: React.ReactNode
    detail?: string
  }[]
  activeIndex: number
  intro?: string
  ariaLabel?: string
  className?: string
}) {
  return (
    <div className={className} aria-label={ariaLabel}>
      <p className="text-xs leading-relaxed text-smoke-600">
        {intro ??
          (steps.length === 1
            ? 'Your wallet will ask for one action.'
            : `Your wallet will ask for ${steps.length} actions. This stays open and advances through each one.`)}
      </p>
      <ol className="mt-3 space-y-2">
        {steps.map((step, index) => {
          const complete = activeIndex > index
          const active = activeIndex === index
          return (
            <li
              key={step.key ?? String(step.title)}
              data-state={complete ? 'complete' : active ? 'active' : 'pending'}
              aria-current={active ? 'step' : undefined}
              className="flex items-start gap-2 text-sm"
            >
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                  complete
                    ? 'border-melon-400 bg-melon-400 text-ink'
                    : active
                      ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700'
                      : 'border-smoke-300 text-smoke-500'
                }`}
              >
                {complete ? '✓' : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={
                    active ? 'font-medium text-ink' : 'block text-smoke-600'
                  }
                >
                  <span className="sr-only">
                    Step {index + 1} of {steps.length}:{' '}
                  </span>
                  {step.title}
                </span>
                {step.detail ? (
                  <span className="mt-0.5 block text-xs text-smoke-500">
                    {step.detail}
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
