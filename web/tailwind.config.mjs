const config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f0f7f9',
        card: '#f8fcfd',
        line: '#d8e7eb',
        ink: '#1c2d33',
        muted: '#57727c',
        accent: '#0e7b90',
        amber: '#2fb3c7',
        teal: '#7fd4e0',
        err: '#b34a35',
        // jbm's scale names, in Sticky's colors, for the transaction engine's UI copied from jbm (ModalShell,
        // TxConfirmDialog, TxSteps, TxError, TransactionReviewDialog, FeeBuybackNotice). Only the shades those
        // files use; each text shade keeps WCAG AA on the backgrounds it sits on.
        bone: '#f8fcfd',
        smoke: { 75: '#f0f7f9', 200: '#d8e7eb', 300: '#57727c', 500: '#57727c', 600: '#57727c', 700: '#1c2d33' },
        grey: { 25: '#f0f7f9', 900: '#1c2d33' },
        bluebs: {
          25: '#e4f2f5',
          50: '#d3eaf0',
          100: '#c3e2e9',
          500: '#0e7b90',
          600: '#0e7b90',
          700: '#0b6576',
          800: '#08505e',
        },
        melon: { 400: '#7fd4e0' },
        split: { 50: '#fdf1ec', 800: '#b34a35' },
      },
      fontFamily: {
        // Body and UI: Beatrice, the site-wide default.
        sans: [
          'var(--font-beatrice)',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        beatrice: [
          'var(--font-beatrice)',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        // Headings: PP Agrandir Wide Bold.
        'agrandir-wide': [
          'var(--font-agrandir-wide)',
          'var(--font-beatrice)',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        // jbm's heading family name, for the engine UI copied from jbm: Sticky's headings.
        agrandir: [
          'var(--font-agrandir-wide)',
          'var(--font-beatrice)',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}

export default config
