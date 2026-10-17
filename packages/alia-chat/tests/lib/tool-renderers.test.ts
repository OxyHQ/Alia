import { describe, expect, it } from 'vitest';
import { parseCatalogueTool, toolRendererKey } from '../../src/tools';

/** A renderer is keyed `<app>:<tool>` from the tool's canonical name and from nothing else. */
describe('toolRendererKey', () => {
  it('reads the app and tool of `oxy_<app>__<tool>` and `self_<app>__<tool>`', () => {
    expect(toolRendererKey('oxy_homiio__searchListings')).toBe('homiio:searchListings');
    expect(toolRendererKey('self_homiio__saveSearch')).toBe('homiio:saveSearch');
    expect(toolRendererKey('oxy_my-app__do_it')).toBe('my-app:do_it');
    expect(parseCatalogueTool('oxy_homiio__searchListings')).toEqual({
      app: 'homiio',
      tool: 'searchListings',
    });
  });

  it('keys nothing else: Alia’s own tools, host tools, free text', () => {
    for (const name of [
      'getWeather',
      'host_homiio__apply_search',
      'homiio:searchListings',
      'oxy_homiio_searchListings',
      'oxy___x',
      'show me oxy_homiio__searchListings',
      'OXY_homiio__x',
    ]) {
      expect(toolRendererKey(name)).toBeNull();
    }
  });
});
