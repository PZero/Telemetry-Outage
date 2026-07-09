import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5000,
    strictPort: true,
    proxy: {
      // Proxy OAuth2 login requests to bypass CORS and strip browser headers
      '/oauth-proxy': {
        target: 'https://login.microsoftonline.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/oauth-proxy/, ''),
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, _req, _res) => {
            // Azure AD blocks client_secret requests containing browser Origin/Referer headers.
            // We strip them here to present it as a standard server-to-server call.
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        }
      },
      // Proxy Azure API Gateway requests to bypass CORS and strip browser headers
      '/api-proxy': {
        target: 'https://ergapim.azure-api.net/databrowsing/v2',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy/, ''),
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, _req, _res) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        }
      }
    }
  }
});
