// Runs in the page before anything else: google.script as Apps Script provides it, with the page told
// its table and member the way doGet tells it, and the address kept through the host
export const STAND_IN_HOST = `
(() => {
  const query = new URLSearchParams(location.search);
  const boot = { baseUrl: location.origin + '/', table: query.get('table'), me: query.get('me') };
  Object.defineProperty(window, 'CND_BOOT', { get: () => boot, set: () => {}, configurable: true });

  const runner = (succeed, fail) => ({
    withSuccessHandler: (handler) => runner(handler, fail),
    withFailureHandler: (handler) => runner(succeed, handler),
    api(body) {
      fetch('/api', { method: 'POST', body })
        .then((response) => response.text())
        .then((text) => succeed && succeed(text), (error) => fail && fail(error));
    },
  });

  window.google = {
    script: {
      get run() { return runner(null, null); },
      history: {
        replace(_state, parameters) {
          const search = new URLSearchParams(parameters).toString();
          history.replaceState(null, '', location.pathname + (search ? '?' + search : ''));
        },
      },
    },
  };
})();
`;
