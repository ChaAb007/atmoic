import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.surface.atomic',
  appName: 'Surface AI',
  webDir: 'dist',
  backgroundColor: '#060b1a',
  android: {
    allowMixedContent: false,
    captureInput: true,
    // Debug prototype: lets chrome://inspect attach to the WebView.
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    // Keep the browser's own fetch: the app streams Server-Sent Events, which CapacitorHttp would buffer.
    CapacitorHttp: { enabled: false },
    SystemBars: {
      // Light status and navigation bar icons on the dark UI.
      style: 'DARK',
      // Edge to edge; the page pads itself with env(safe-area-inset-*) / --safe-area-inset-*.
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;
