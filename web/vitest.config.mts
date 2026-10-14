import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
 resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
 test: { server: { deps: { inline: ['@bananapus/nana-sdk-react'] } }, include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'jsdom', setupFiles: ['./test/setup.ts', './test/dialog-shim.ts', './test/review-calls-setup.ts'] },
})
