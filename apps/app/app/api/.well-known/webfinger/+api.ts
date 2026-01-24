/**
 * WebFinger API endpoint
 * Returns actor information for @alia@alia.onl
 * This enables Mastodon and other ActivityPub servers to discover Alia
 */

export async function GET(request: Request) {
  // Parse query parameters
  const url = new URL(request.url);
  const resource = url.searchParams.get('resource');

  // Check if requesting Alia's account
  if (
    resource === 'acct:alia@alia.onl' ||
    resource === 'https://api.alia.onl/actors/alia' ||
    resource === 'alia@alia.onl'
  ) {
    // Return WebFinger response pointing to the ActivityPub actor
    return new Response(
      JSON.stringify({
        subject: 'acct:alia@alia.onl',
        aliases: [
          'https://api.alia.onl/actors/alia',
          'https://api.alia.onl/@alia'
        ],
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: 'https://api.alia.onl/actors/alia'
          },
          {
            rel: 'http://webfinger.net/rel/profile-page',
            type: 'text/html',
            href: 'https://api.alia.onl/@alia'
          }
        ]
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/jrd+json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600'
        }
      }
    );
  }

  // Resource not found
  return new Response(
    JSON.stringify({ error: 'Resource not found' }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}

// Handle CORS preflight
export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
