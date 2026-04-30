import { eventBus } from "#web/eventBus.js";

export function broadcast(event) {
  eventBus.emit("broadcast", event);
}

export function registerConnection(_ws) {}
