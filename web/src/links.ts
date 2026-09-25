// Input | output.text | output.href
// https://console.cloud.google.com/apis/credentials/oauthclient/1234567890-abcdefghijklmnop.apps.googleusercontent.com?project=rails-prod | console.cloud.google.com › credentials › oauthclient ↗ | https://console.cloud.google.com/apis/credentials/oauthclient/1234567890-abcdefghijklmnop.apps.googleusercontent.com?project=rails-prod
// https://www.example.com/a/b?x=1#top | example.com › a › b ↗ | https://www.example.com/a/b?x=1#top
// https://example.com/1234/orders | example.com › orders ↗ | https://example.com/1234/orders
// https://example.com/a/abcdefghijklmnopqrstuvwxyz | example.com › a ↗ | https://example.com/a/abcdefghijklmnopqrstuvwxyz
// https://example.com/ | example.com ↗ | https://example.com/
// https://example.com/foo%20bar/finish | example.com › foo bar › finish ↗ | https://example.com/foo%20bar/finish
export function urlChip(url: string): { text: string; href: string } {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./i, '')
    const segments = parsed.pathname.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part) } catch { return part }
    }).filter((part) => !/^\d+$/.test(part) && part.length <= 24)
    return { text: [...[host], ...segments.slice(-2), '↗'].join(' › ').replace(' › ↗', ' ↗'), href: url }
  } catch {
    return { text: 'Open link ↗', href: url }
  }
}

