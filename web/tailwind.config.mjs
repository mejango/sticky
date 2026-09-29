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
        accent: '#0e7c91',
        amber: '#2fb3c7',
        teal: '#7fd4e0',
        err: '#b34a35',
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
      },
    },
  },
  plugins: [],
}

export default config
