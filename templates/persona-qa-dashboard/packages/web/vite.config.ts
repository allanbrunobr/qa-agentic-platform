/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { createRuntimeApiProxy } from './src/server/runtime-api-proxy'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: {
    // The dashboard calls the API through this proxy, which adds the local API token server-side.
    proxy: createRuntimeApiProxy({
      target: process.env.AGENTIC_QA_API_URL || 'http://localhost:3001',
      tokenPath: process.env.AGENTIC_QA_API_TOKEN_PATH || path.resolve(__dirname, '../../data/runtime-api.token'),
    }),
  },
})
