import { defineConfig } from 'vite'

// Production build for the headless WxCC↔Oracle bridge. Outputs a single
// classic (non-module) script — public/wxcc-oracle-bridge.js — that
// WxCC Desktop's "agentx-custom-desktop" widget loader injects directly
// into its own document via a plain <script src>. No React/JSX here: the
// bridge renders nothing, so this build has no plugin-react dependency
// and no CSS/code-splitting concerns.
//
// Output goes to public/ (not a separate dist-widget/) specifically so
// `npm run dev` serves it at /wxcc-oracle-bridge.js on the SAME server
// you're already tunneling out — no extra static server to stand up.
// emptyOutDir is false so this doesn't wipe the other public/ assets.
export default defineConfig({
  publicDir: false, // outDir is public/ itself — don't have Vite also copy it into itself
  build: {
    outDir: 'public',
    emptyOutDir: false,
    lib: {
      entry: 'src/bridge.ts',
      name: 'WxccOracleBridge',
      formats: ['iife'],
      fileName: () => 'wxcc-oracle-bridge.js',
    },
  },
})
