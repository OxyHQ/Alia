const RUNTIME_PREFIX = '/bloom-character/';

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    // The 3D character runtime is shared: `@alia.onl/sdk` loads it from this origin in every
    // app that mounts the chat, and a cross-origin module import needs CORS to run at all.
    if (!new URL(request.url).pathname.startsWith(RUNTIME_PREFIX)) return response;
    const shared = new Response(response.body, response);
    shared.headers.set('Access-Control-Allow-Origin', '*');
    return shared;
  },
};
