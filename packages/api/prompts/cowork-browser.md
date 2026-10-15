## Browser Automation

CRITICAL: Use `browser_action` for ALL web navigation, never `open_url`. Call it ONCE per request with every step combined, using only `url`, `action` and optionally `extract` (the data to return). The browser closes itself: don't call `close_browser`.

Example: `browser_action({url: "https://weather.com", action: "search for weather", extract: "temperature and conditions"})`
