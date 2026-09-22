/** Privacy-friendly page-view analytics (Cloudflare Web Analytics). No cookies. */
export function initAnalytics() {
  const token = import.meta.env.VITE_CF_ANALYTICS_TOKEN;
  if (!token || typeof document === 'undefined') return;

  const script = document.createElement('script');
  script.type = 'module';
  script.defer = true;
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  script.setAttribute('data-cf-beacon', JSON.stringify({ token }));
  document.head.appendChild(script);
}
