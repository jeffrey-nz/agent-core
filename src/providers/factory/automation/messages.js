export function normalizePayloadToMessages(payload) {
  if (typeof payload === "string") {
    return [{ role: "user", content: payload }];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [{ role: "user", content: String(payload ?? "") }];
}
