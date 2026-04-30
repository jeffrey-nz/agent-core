export function createToolDispatcher(handlers) {
  return async function dispatch(name, input, context = {}) {
    const handler = handlers[name];
    if (!handler) return undefined;
    return handler(input, context);
  };
}
