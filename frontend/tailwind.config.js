/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      colors: {
        canvas: {
          DEFAULT: 'rgb(var(--color-canvas) / <alpha-value>)',
          soft: 'rgb(var(--color-canvas-soft) / <alpha-value>)',
          raised: 'rgb(var(--color-canvas-raised) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--color-ink) / <alpha-value>)',
          muted: 'rgb(var(--color-ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--color-ink-faint) / <alpha-value>)',
          inverse: 'rgb(var(--color-ink-inverse) / <alpha-value>)',
        },
        'on-accent': 'rgb(var(--color-on-accent) / <alpha-value>)',
        line: {
          DEFAULT: 'rgb(var(--color-line) / <alpha-value>)',
          strong: 'rgb(var(--color-line-strong) / <alpha-value>)',
        },
        ember: {
          DEFAULT: 'rgb(var(--color-ember) / <alpha-value>)',
          dark: 'rgb(var(--color-ember-dark) / <alpha-value>)',
          hover: 'rgb(var(--color-ember-hover) / <alpha-value>)',
          soft: 'rgb(var(--color-ember-soft) / <alpha-value>)',
        },
        forest: {
          DEFAULT: 'rgb(var(--color-forest) / <alpha-value>)',
          dark: 'rgb(var(--color-forest-dark) / <alpha-value>)',
          soft: 'rgb(var(--color-forest-soft) / <alpha-value>)',
        },
        plum: {
          DEFAULT: 'rgb(var(--color-plum) / <alpha-value>)',
          dark: 'rgb(var(--color-plum-dark) / <alpha-value>)',
          soft: 'rgb(var(--color-plum-soft) / <alpha-value>)',
          tint: 'rgb(var(--color-plum-tint) / <alpha-value>)',
        },
        ochre: {
          DEFAULT: 'rgb(var(--color-ochre) / <alpha-value>)',
          dark: 'rgb(var(--color-ochre-dark) / <alpha-value>)',
          soft: 'rgb(var(--color-ochre-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--color-danger) / <alpha-value>)',
          dark: 'rgb(var(--color-danger-dark) / <alpha-value>)',
          soft: 'rgb(var(--color-danger-soft) / <alpha-value>)',
        },
        charcoal: {
          DEFAULT: 'rgb(var(--color-charcoal) / <alpha-value>)',
          raised: 'rgb(var(--color-charcoal-raised) / <alpha-value>)',
          hover: 'rgb(var(--color-charcoal-hover) / <alpha-value>)',
          line: 'rgb(var(--color-charcoal-line) / <alpha-value>)',
          ink: 'rgb(var(--color-charcoal-ink) / <alpha-value>)',
          muted: 'rgb(var(--color-charcoal-muted) / <alpha-value>)',
          faint: 'rgb(var(--color-charcoal-faint) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
